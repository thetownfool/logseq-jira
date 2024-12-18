import "@logseq/libs";
import React from "react";
import * as ReactDOM from "react-dom/client";
import Axios, { AxiosError } from 'axios';
import https from 'https';

import App from "./App";
import "./index.css";
import { settings } from './settings';
import type { Settings } from './models';
import { logseq as PL } from "../package.json";
import { extractIssues as extractIssueKeys, statusCategoryGenerator, getAuthHeader, orgModeRegexes, markdownRegexes } from "./utils";
import { db } from "./db";
import { BlockEntity } from "@logseq/libs/dist/LSPlugin";

// Add Axios
const axios = Axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false })
});

type Data = Record<
  string,
  {
    text: string;
    summary: string;
    status: string;
    type: string;
    priority: string;
    creator: string;
    reporter: string;
    assignee: string;
    fixVersion: string;
    resolution: string;
  }
>;

// @ts-expect-error
const css = (t: TemplateStringsArray, ...args) => String.raw(t, ...args);

const pluginId = PL.id;

async function main() {

  await db.open();

  console.info(`#${pluginId}: MAIN`);
  const root = ReactDOM.createRoot(document.getElementById("app")!);

  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );

  // Setup Logseq settings
  logseq.useSettingsSchema(settings);

  // Register Logseq commands
  logseq.Editor.registerSlashCommand('Jira: Pull JQL results', async () => {
    await getJQLResults();
  })

  // Register Slash command for Update issue.
  logseq.Editor.registerSlashCommand('Jira: Update Issue', async () => {
    await updateJiraIssue(false);
  });

  // Register Slash command for 2nd organization if enabled.
  if (logseq.settings?.enableSecond) {
    logseq.Editor.registerSlashCommand('Jira: Update Issue for 2nd Org.', async () => {
      await updateJiraIssue(true);
    });
  }

  logseq.ready().then(async () => {
    if (logseq.settings?.autoRefresh === "No") return;
    console.log("Starting DB refresh");

    await db.issues.each(async (val) => {
      await updateJiraIssue(val.useSecondOrg, val.blockid);
    })
    const count = await db.issues.count();
    logseq.UI.showMsg(`Experimental: Refresh ${count} Jira issues...`)
  })

  logseq.beforeunload(async () => {
    db.close();
  })

}

async function getJQLResults(useSecondOrg: boolean = false) {
  try {
    const block = await logseq.Editor.getCurrentBlock();
    const settings = logseq.settings;

    const baseURL = useSecondOrg ? settings?.jiraBaseURL2 : settings?.jiraBaseURL;
    const token = useSecondOrg ? settings?.jiraAPIToken2 : settings?.jiraAPIToken;
    const user = useSecondOrg ? settings?.jiraUsername2 : settings?.jiraUsername;
    const apiVersion = useSecondOrg ? settings?.jiraAPIVersion2 : settings?.jiraAPIVersion || "3";
    const authType = (useSecondOrg ? settings?.jiraAuthType2 : settings?.jiraAuthType) as string;
    const enableOrgMode = settings?.enableOrgMode as boolean;
    const jqlTitle = settings?.jqlQueryTitle as string;

    if (!baseURL || !token || !user) {
      logseq.UI.showMsg('Jira credentials not set. Update in Plugin settings.')
      throw new Error('Jira base URL not set.');
    }

    const creds: string = btoa(`${user}:${token}`);
    const authHeader = getAuthHeader(useSecondOrg, token, user, creds, authType);
    const jqlQuery = `https://${baseURL}/rest/api/${apiVersion}/search?jql=${settings?.jqlQuery}`;

    const response = await axios.get(jqlQuery, {
      headers: {
        'Accept': 'application/json',
        'Authorization': authHeader
      }
    });

    const issues = response.data.issues.map((issue: any) => {
      const jiraURL = `https://${baseURL}/browse/${issue.key}`
      return { body: issue, jiraURL }
    })

    if (!!block) {
      const outputBlocks = issues.map((row: any) =>
        enableOrgMode ? `[[${row.jiraURL}][${statusCategoryGenerator(row.body.fields.status.statusCategory.colorName)} ${row.body.fields.status.statusCategory.name} - ${row.body.key}|${row.body.fields.summary}]]` :
          `[${statusCategoryGenerator(row.body.fields.status.statusCategory.colorName)} ${row.body.fields.status.statusCategory.name} - ${row.body.key}|${row.body.fields.summary}](${row.jiraURL})`);

      if (jqlTitle) await logseq.Editor.updateBlock(block.uuid, jqlTitle);
      
      await logseq.Editor.insertBatchBlock(
        block.uuid,
        outputBlocks.map((content: any) => ({
          content: `${content}`,
        })),
        {
          before: false,
          sibling: false
        });
    }
  } catch (e: any) {
    logseq.UI.showMsg(`Failed to fetch JQL results: ${e.message}`, 'error');
  }

}

// Main function to update Jira issues
async function updateJiraIssue(useSecondOrg: boolean = false, blockUUID?: string): Promise<void> {
  try {

    let currentBlock: BlockEntity | null;
    let value: string;
    if (blockUUID) {
      currentBlock = await logseq.Editor.getBlock(blockUUID);
      value = currentBlock?.content ?? "";
    } else {
      currentBlock = await logseq.Editor.getCurrentBlock();
      value = await logseq.Editor.getEditingBlockContent();
    }


    if (!currentBlock) {
      throw new Error('Select a block before running this command');
    }

    const issueKeys = extractIssueKeys(value);

    if (!issueKeys || issueKeys.length < 1) {
      logseq.UI.showMsg("Couldn't find any Jira issues.", 'error');
      throw new Error("Couldn't find a valid Jira issue key.");
    }

    const issues = await getIssues(issueKeys, useSecondOrg);
    if (issues === undefined) return;
    const enableOrgMode = logseq.settings?.enableOrgMode as boolean ?? false;
    const data = generateTextFromResponse(issues, enableOrgMode);
    let newValue = value;
    if (logseq.settings?.updateInlineText) {
      newValue = await replaceAsync(value, data, enableOrgMode);
    }

    if (logseq.settings?.addToBlockProperties) {
      const properties = genProperties(data[issueKeys[0]]);
      newValue = formatTextBlock(newValue, properties);
    }

    await logseq.Editor.updateBlock(currentBlock.uuid, newValue);

    await db.issues.add({ blockid: currentBlock.uuid, name: issueKeys.toString(), useSecondOrg, timestamp: Date.now() });

  } catch (e) {
    //console.error('logseq-jira', e.message);
  }
}

// Fetch Jira issues
async function getIssues(issues: Array<string>, useSecondOrg = false) {
  try {
    const settings = logseq.settings;
    const baseURL = useSecondOrg ? settings?.jiraBaseURL2 : settings?.jiraBaseURL;
    const token = useSecondOrg ? settings?.jiraAPIToken2 : settings?.jiraAPIToken;
    const user = useSecondOrg ? settings?.jiraUsername2 : settings?.jiraUsername;
    const apiVersion = useSecondOrg ? settings?.jiraAPIVersion2 : settings?.jiraAPIVersion || "3";
    const authType = (useSecondOrg ? settings?.jiraAuthType2 : settings?.jiraAuthType) as string;

    if (!baseURL || !token || !user) {
      logseq.UI.showMsg('Jira credentials not set. Update in Plugin settings.')
      throw new Error('Jira base URL not set.');
    }

    const creds: string = btoa(`${user}:${token}`);
    const authHeader = getAuthHeader(useSecondOrg, token, user, creds, authType as string);

    const requests = issues.map(async (issueKey: string) => {
      const issueRest = `https://${baseURL}/rest/api/${apiVersion}/issue/${issueKey}`;
      const jiraURL = `https://${baseURL}/browse/${issueKey}`;

      try {
        const response = await axios.get(issueRest, {
          headers: {
            'Accept': 'application/json',
            'Authorization': authHeader
          }
        });

        return { body: response.data, jiraURL }
      } catch (e: any) {
        logseq.UI.showMsg(`Failed to fetch ${issueKey}: ${e.message}`, 'error');
        return null;
      }
    }
    );
    const result = await Promise.all(requests);

    return result.filter((i) => i !== null) // Filter out erroneous responses.

  } catch (e: any) {
    logseq.UI.showMsg(`Failed to fetch issues: ${e.message}`, 'error');
  }
};

// Generate markdown text from response data
function generateTextFromResponse(responses: any[], enableOrdMode: boolean): Data {
  const data: Data = {};

  responses.forEach(({ jiraURL, body: { key, fields } }) => {
    const text = enableOrdMode ? `[[${jiraURL}][${statusCategoryGenerator(fields.status.statusCategory.colorName)} ${fields.status.statusCategory.name} - ${key}|${fields.summary}]]` :
      `[${statusCategoryGenerator(fields.status.statusCategory.colorName)} ${fields.status.statusCategory.name} - ${key}|${fields.summary}](${jiraURL})`
    data[key] = {
      text: text,
      summary: fields.summary ?? 'None',
      status: fields.status?.name ?? 'None',
      type: fields.issuetype?.name ?? 'None',
      priority: fields.priority?.name ?? 'None',
      creator: fields.creator?.displayName ?? 'None',
      reporter: fields.reporter?.displayName ?? 'None',
      assignee: fields.assignee?.displayName ?? 'None',
      fixVersion: fields.fixVersions?.[0]?.name ?? 'None',
      resolution: fields.resolution?.name ?? null,
    };
  });
  return data;
}

// Helper to perform regex replacements asynchronously
async function replaceAsync(str: string, data: Data, enableOrgMode: boolean): Promise<string> {
  let newString = str;
  const replacedIssues = new Set<string>();
  const regexes = enableOrgMode ? orgModeRegexes : markdownRegexes;

  for (const regex of regexes) {
    newString = newString.replace(regex, (match, ...args) => {
      const groups = args.pop();
      const issue = groups.issue;

      if (replacedIssues.has(issue)) {
        return match;
      }

      if (data[issue]) {
        replacedIssues.add(issue);
        return data[issue].text;
      }

      return match;
    });
  }

  return newString;
}
// Format block text with properties
function formatTextBlock(input: string, keyValuePairs: Record<string, string>): string {
  const lines = input.split('\n');
  const existingKeys = new Set<string>();

  for (const line of lines) {
    const separatorIndex = line.indexOf('::');
    if (separatorIndex !== -1) {
      const key = line.slice(0, separatorIndex).trim();
      existingKeys.add(key);
    }
  }

  let formattedText = input;

  for (const [key, value] of Object.entries(keyValuePairs)) {
    if (!existingKeys.has(key)) {
      formattedText += `\n${key}:: ${value}`;
    } else {
      const regex = new RegExp(`${key}::.*`, 'g');
      formattedText = formattedText.replace(regex, `${key}:: ${value}`);
    }
  }

  return formattedText;
}

// Generate properties object from data
function genProperties(properties: any): Record<string, string> {
  const { assignee, priority, fixVersion, status, reporter, summary, resolution } = properties;
  const settings = logseq.settings as unknown as Settings;
  const {
    showSummary,
    showAssignee,
    showPriority,
    showFixVersion,
    showStatus,
    showReporter,
    showResolution,
  } = settings;

  const propertyObject: Record<string, string> = {};

  if (showSummary) propertyObject.summary = summary;
  if (showAssignee) propertyObject.assignee = assignee;
  if (showPriority) propertyObject.priority = priority;
  if (showFixVersion) propertyObject['fix-version'] = fixVersion;
  if (showStatus) propertyObject.status = status;
  if (showReporter) propertyObject.reporter = reporter;
  if (showResolution && resolution) propertyObject.resolution = resolution;

  return propertyObject;
}


logseq.ready(main).catch(console.error);
