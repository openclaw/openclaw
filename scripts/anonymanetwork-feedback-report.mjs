#!/usr/bin/env node

const repo = process.env.ANONYMANETWORK_UPSTREAM_REPO || "openclaw/openclaw";
const perPage = Number(process.env.ANONYMANETWORK_REPORT_LIMIT || "100");
const endpoint = `https://api.github.com/repos/${repo}/issues?state=all&per_page=${Math.min(perPage, 100)}&sort=comments&direction=desc`;

const headers = { "User-Agent": "anonymanetwork-feedback-report" };

if (process.env.GITHUB_TOKEN) {
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

const response = await fetch(endpoint, { headers });
if (!response.ok) {
  console.error(`Request failed: ${response.status} ${response.statusText}`);
  process.exit(1);
}

const items = await response.json();
const issues = items.filter((item) => !item.pull_request);

const top = issues.slice(0, 20).map((issue) => ({
  number: issue.number,
  state: issue.state,
  comments: issue.comments,
  title: issue.title,
  labels: issue.labels.map((label) => label.name),
  url: issue.html_url,
}));

const summary = {
  generatedAt: new Date().toISOString(),
  sourceRepo: repo,
  issuesScanned: issues.length,
  top,
};

console.log(JSON.stringify(summary, null, 2));
