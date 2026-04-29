#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import process from 'node:process';

const CATEGORY_ORDER = [
  'MS Teams (channel plugin)',
  'Windows platform',
  'WSL',
  'Azure',
  'SharePoint / M365',
];

const CATEGORY_TITLES = {
  'MS Teams (channel plugin)': 'MS Teams Channel Plugin',
  'Windows platform': 'Windows Platform',
  WSL: 'WSL (Windows Subsystem for Linux)',
  Azure: 'Azure (Provider / Infrastructure)',
  'SharePoint / M365': 'Microsoft 365 / SharePoint',
};

const TITLE_TERMS = {
  'MS Teams (channel plugin)': [
    'msteams',
    'msteams',
    'microsoft teams',
    'ms teams',
    'teams:',
    'teams channel',
    'teams plugin',
    'bot framework',
    'fileconsent',
    'graphtenantid',
  ],
  'Windows platform': [
    'windows',
    'powershell',
    'win32',
    'winget',
    'setlocal',
    'scheduled task',
    'schtasks',
    'cmd.exe',
    'wscript',
    '0xc0000409',
  ],
  WSL: ['wsl', 'wsl2', 'windows subsystem'],
  Azure: [
    'azure',
    'entra',
    'aad',
    'msal',
    'managed identity',
    'defaultazurecredential',
    'federated credential',
    'ai foundry',
  ],
  'SharePoint / M365': [
    'm365',
    'microsoft 365',
    'sharepoint',
    'onedrive',
    'microsoft graph',
    'graph api',
  ],
};

const LABEL_TERMS = {
  'MS Teams (channel plugin)': ['channel: msteams', 'plugin: azure-speech'],
  'Windows platform': [],
  WSL: [],
  Azure: ['plugin: azure-speech'],
  'SharePoint / M365': ['sharepoint'],
};

const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

function parseArgs(argv) {
  const args = {
    repo: 'openclaw/openclaw',
    output: 'MICROSOFT_TRACKER.md',
    updatePrBody: undefined,
    includeBroadMsteamsLabels: true,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo') args.repo = requiredValue(argv, ++i, arg);
    else if (arg === '--output' || arg === '-o') args.output = requiredValue(argv, ++i, arg);
    else if (arg === '--update-pr-body') args.updatePrBody = requiredValue(argv, ++i, arg);
    else if (arg === '--no-broad-msteams-labels') args.includeBroadMsteamsLabels = false;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Generate the Microsoft ecosystem tracker.\n\nUsage:\n  node scripts/generate-microsoft-tracker.mjs [options]\n\nOptions:\n  --repo <owner/name>          GitHub repository to scan (default: openclaw/openclaw)\n  -o, --output <file>         Markdown output path (default: MICROSOFT_TRACKER.md)\n  --update-pr-body <number>   Replace the PR body with the generated tracker markdown\n  --no-broad-msteams-labels   Exclude broad PRs that only match channel: msteams labels\n  -h, --help                  Show this help\n\nRequires:\n  gh auth login\n`);
}

function ghJson(args) {
  const stdout = execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout || '[]');
}

function gh(args) {
  execFileSync('gh', args, { encoding: 'utf8', stdio: 'inherit' });
}

function labelsFor(item) {
  return (item.labels ?? []).map((label) => label.name).filter(Boolean);
}

function assigneesFor(item) {
  return (item.assignees ?? []).map((assignee) => assignee.login).filter(Boolean);
}

function matchedCategories(item, includeBroadMsteamsLabels) {
  const title = (item.title ?? '').toLowerCase();
  const labels = labelsFor(item).map((label) => label.toLowerCase());
  const matches = [];

  for (const category of CATEGORY_ORDER) {
    const titleMatch = TITLE_TERMS[category].some((term) => title.includes(term));
    const labelTerms = includeBroadMsteamsLabels
      ? LABEL_TERMS[category]
      : LABEL_TERMS[category].filter((term) => term !== 'channel: msteams');
    const labelMatch = labelTerms.some((term) => labels.includes(term));
    if (titleMatch || labelMatch) matches.push(category);
  }

  return matches;
}

function priorityFor(title, labels) {
  const text = `${title} ${labels.join(' ')}`.toLowerCase();
  if (['security', 'cve', 'sandbox'].some((term) => text.includes(term))) return 'P0';
  if (
    [
      'crash',
      'crash-loop',
      'startup',
      'fails to start',
      'fail to start',
      'broken',
      'regression',
      'unauthorized',
      'jwt',
      '401',
      '403',
      'auth',
      'data loss',
      'lost message',
      'drops',
      'not downloaded',
      'silent',
      'deadlock',
      'blocked',
      'stack buffer',
      '0xc0000409',
    ].some((term) => text.includes(term))
  ) {
    return 'P1';
  }
  return 'P2';
}

function sectionFor(kind, title, labels) {
  if (kind === 'pr') return 'PRs';
  const text = `${title} ${labels.join(' ')}`.toLowerCase();
  if (['feature', 'enhancement', 'support', 'feat('].some((term) => text.includes(term))) {
    return 'Feature Requests';
  }
  return 'Bugs / Crashes';
}

function normalizeItem(item, includeBroadMsteamsLabels) {
  const categories = matchedCategories(item, includeBroadMsteamsLabels);
  if (categories.length === 0) return undefined;

  const labels = labelsFor(item);
  const title = item.title ?? '';
  const category = CATEGORY_ORDER.find((candidate) => categories.includes(candidate));
  const kind = item.pull_request ? 'pr' : 'issue';

  return {
    kind,
    number: item.number,
    title,
    url: item.html_url,
    labels,
    assignees: assigneesFor(item),
    category,
    matchedCategories: categories,
    priority: priorityFor(title, labels),
    section: sectionFor(kind, title, labels),
  };
}

function escapeCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function labelCell(labels) {
  if (labels.length === 0) return '';
  const visible = labels.slice(0, 6).map((label) => `\`${escapeCell(label)}\``).join(' ');
  return labels.length > 6 ? `${visible} +${labels.length - 6}` : visible;
}

function assigneeCell(assignees) {
  return assignees.map((assignee) => `@${assignee}`).join(', ');
}

function sizeCell(labels) {
  const size = labels.find((label) => label.toLowerCase().startsWith('size:'));
  return size ? size.split(':').slice(1).join(':').trim().toUpperCase() : '';
}

function issueRow(record) {
  return `| [ ] | ${record.priority} | #${record.number} | ${escapeCell(record.title)} | ${labelCell(record.labels)} | ${assigneeCell(record.assignees)} |`;
}

function prRow(record) {
  return `| [ ] | ${record.priority} | #${record.number} | ${escapeCell(record.title)} | ${sizeCell(record.labels)} | ${assigneeCell(record.assignees)} |`;
}

function sortRecords(records) {
  records.sort((a, b) => {
    return (
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
      (a.kind === 'issue' ? 0 : 1) - (b.kind === 'issue' ? 0 : 1) ||
      (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
      b.number - a.number
    );
  });
  return records;
}

function groupRecords(records) {
  const groups = new Map();
  for (const category of CATEGORY_ORDER) {
    groups.set(`${category}:issue`, []);
    groups.set(`${category}:pr`, []);
  }
  for (const record of records) {
    groups.get(`${record.category}:${record.kind}`).push(record);
  }
  for (const group of groups.values()) sortRecords(group);
  return groups;
}

function buildMarkdown(records, { includeBroadMsteamsLabels }) {
  const groups = groupRecords(records);
  const lines = [];
  const now = new Date().toISOString().slice(0, 10);

  lines.push(
    '# Microsoft Ecosystem Issues & PRs Tracker',
    '',
    '> **Purpose:** Living checklist for maintainers to track all open Microsoft-related issues and PRs (Teams, Windows, WSL, Azure, M365/SharePoint).',
    '>',
    '> **How to use:**',
    '>',
    '> - Mark items resolved by editing this PR body and changing `[ ]` to `[x]`',
    '> - Claim items by adding your GitHub handle to the `Assignee` column',
    '> - Priority guide: **P0** = crash/blocker/security, **P1** = significant bug/regression, **P2** = minor bug/enhancement, **P3** = nice-to-have/stale',
    '> - Items marked _(stale)_ have been flagged by the stale bot due to inactivity',
    '>',
    `> **Last updated:** ${now} (post-purge audit: refreshed from currently open GitHub issues/PRs and rebuilt from PR #49126 format)`,
    '',
    '---',
    '',
    '## Summary',
    '',
    '| Category | Issues | PRs | Total | Closed | Remaining |',
    '| -------- | ------ | --- | ----- | ------ | --------- |',
  );

  let totalIssues = 0;
  let totalPrs = 0;
  for (const category of CATEGORY_ORDER) {
    const issues = groups.get(`${category}:issue`).length;
    const prs = groups.get(`${category}:pr`).length;
    totalIssues += issues;
    totalPrs += prs;
    lines.push(`| ${category} | ${issues} | ${prs} | ${issues + prs} | 0 | ${issues + prs} |`);
  }
  lines.push(
    `| **Total** | **${totalIssues}** | **${totalPrs}** | **${totalIssues + totalPrs}** | **0** | **${totalIssues + totalPrs}** |`,
    '',
    '---',
  );

  let sectionNumber = 1;
  for (const category of CATEGORY_ORDER) {
    const title = CATEGORY_TITLES[category];
    const issues = groups.get(`${category}:issue`);
    const prs = groups.get(`${category}:pr`);
    const bugs = issues.filter((record) => record.section !== 'Feature Requests');
    const features = issues.filter((record) => record.section === 'Feature Requests');

    lines.push('', `## ${sectionNumber}. ${title} — Issues`, '', '### Bugs / Crashes', '');
    appendIssueTable(lines, bugs);
    lines.push('', '### Feature Requests', '');
    appendIssueTable(lines, features);
    lines.push('', '---');

    sectionNumber += 1;
    lines.push('', `## ${sectionNumber}. ${title} — PRs`, '');
    appendPrTable(lines, prs);
    lines.push('', '---');
    sectionNumber += 1;
  }

  appendAppendix(lines, 'P0 Blockers (Start Here)', records.filter((record) => record.priority === 'P0'));
  appendAppendix(lines, 'High-Priority Bugs / Regressions', records.filter((record) => record.priority === 'P1'));
  appendAppendix(
    lines,
    'Stale Items (Consider Closing)',
    records.filter((record) => record.labels.some((label) => label.toLowerCase() === 'stale')),
  );

  lines.push(
    '',
    '## Audit Notes',
    '',
    '- Rebuilt from the format of PR #49126 after the issue/PR purge.',
    '- Source set is currently open GitHub issues and PRs from `openclaw/openclaw`; closed counts are intentionally reset to `0` for this refreshed tracker.',
    '- Included title/label matches for `msteams`, Microsoft Teams, Windows, WSL, Azure, Entra/AAD, MSAL, managed identity, DefaultAzureCredential, Microsoft Graph, SharePoint, OneDrive, and Microsoft 365.',
    includeBroadMsteamsLabels
      ? '- Kept broad multi-channel PRs when they carry `channel: msteams`, because those can still affect the Microsoft surface area.'
      : '- Excluded broad multi-channel PRs that only match `channel: msteams`; rerun without `--no-broad-msteams-labels` to include them.',
    '- Generated with `node scripts/generate-microsoft-tracker.mjs` so the tracker and PR body can be refreshed after future triage passes.',
  );

  return `${lines.join('\n')}\n`;
}

function appendIssueTable(lines, records) {
  if (records.length === 0) {
    lines.push('_No currently open items found._');
    return;
  }
  lines.push(
    '| Resolved? | Priority | # | Title | Labels | Assignee |',
    '| --------- | -------- | - | ----- | ------ | -------- |',
    ...records.map(issueRow),
  );
}

function appendPrTable(lines, records) {
  if (records.length === 0) {
    lines.push('_No currently open items found._');
    return;
  }
  lines.push(
    '| Resolved? | Priority | # | Title | Size | Assignee |',
    '| --------- | -------- | - | ----- | ---- | -------- |',
    ...records.map(prRow),
  );
}

function appendAppendix(lines, title, records) {
  lines.push('', `## Appendix: ${title}`, '');
  if (records.length === 0) {
    lines.push('_No matching items found._');
    return;
  }
  lines.push('| Category | Type | Priority | # | Title |', '| -------- | ---- | -------- | - | ----- |');
  for (const record of sortRecords([...records])) {
    lines.push(`| ${record.category} | ${record.kind} | ${record.priority} | #${record.number} | ${escapeCell(record.title)} |`);
  }
}

const args = parseArgs(process.argv);
const issueItems = ghJson([
  'issue',
  'list',
  '--repo',
  args.repo,
  '--state',
  'open',
  '--limit',
  '10000',
  '--json',
  'number,title,url,labels,assignees',
]).map((item) => ({ ...item, html_url: item.url }));
const prItems = ghJson([
  'pr',
  'list',
  '--repo',
  args.repo,
  '--state',
  'open',
  '--limit',
  '10000',
  '--json',
  'number,title,url,labels,assignees',
]).map((item) => ({ ...item, html_url: item.url, pull_request: true }));
const records = sortRecords(
  [...issueItems, ...prItems]
    .map((item) => normalizeItem(item, args.includeBroadMsteamsLabels))
    .filter((record) => record !== undefined),
);
const markdown = buildMarkdown(records, args);
writeFileSync(args.output, markdown);
console.log(`Generated ${args.output}: ${records.length} open Microsoft-related records`);

if (args.updatePrBody) {
  gh(['pr', 'edit', args.updatePrBody, '--repo', args.repo, '--body-file', args.output]);
  console.log(`Updated PR #${args.updatePrBody} body from ${args.output}`);
}
