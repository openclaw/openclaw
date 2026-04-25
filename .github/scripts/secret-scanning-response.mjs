#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

const apiBaseUrl = process.env.SECRET_SCANNING_API_BASE_URL || "https://api.github.com";
const token = process.env.GITHUB_TOKEN;
const repository = process.env.SECRET_SCANNING_REPOSITORY || process.env.GITHUB_REPOSITORY;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseEventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    return {};
  }
  return JSON.parse(fs.readFileSync(eventPath, "utf8"));
}

function normalizeApiUrl(urlOrPath) {
  if (!urlOrPath) {
    return null;
  }
  if (urlOrPath.startsWith("https://")) {
    return urlOrPath;
  }
  if (urlOrPath.startsWith("/")) {
    return `${apiBaseUrl}${urlOrPath}`;
  }
  return `${apiBaseUrl}/${urlOrPath}`;
}

async function requestJson(urlOrPath, init = {}) {
  const url = normalizeApiUrl(urlOrPath);
  if (!url) {
    fail("Missing API URL");
  }

  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    fail(`${response.status} ${response.statusText} for ${url}: ${body}`);
  }

  return response.json();
}

async function paginateJson(urlOrPath) {
  const items = [];
  let nextUrl = normalizeApiUrl(urlOrPath);

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      fail(`${response.status} ${response.statusText} for ${nextUrl}: ${body}`);
    }

    const page = await response.json();
    if (Array.isArray(page)) {
      items.push(...page);
    } else {
      items.push(page);
    }

    const linkHeader = response.headers.get("link") || "";
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = nextMatch?.[1] ?? null;
  }

  return items;
}

function extractIssueNumberFromHtmlUrl(htmlUrl) {
  const match = String(htmlUrl || "").match(/\/(issues|pull)\/(\d+)/);
  return match ? Number(match[2]) : null;
}

function normalizeAuthor(login) {
  if (!login || typeof login !== "string") {
    return null;
  }
  if (login.endsWith("[bot]")) {
    return null;
  }
  return login;
}

function buildNotificationBody({ alertNumber, authors }) {
  const marker = `<!-- barnacle-secret-scan:${alertNumber} -->`;
  const mentions = authors.length > 0 ? authors.map((author) => `@${author}`).join(" ") : "";
  const prefix = mentions ? `${mentions} ` : "";
  return `${marker}
${prefix}please review the content in this thread and make sure it does not include passwords, tokens, API keys, or other sensitive information. If anything sensitive was posted, remove or rotate it and update the thread with a redacted version.`;
}

async function fetchAlertNumber() {
  const payload = parseEventPayload();
  const envNumber = process.env.SECRET_SCANNING_ALERT_NUMBER;
  const payloadNumber = payload?.alert?.number ?? payload?.number;
  const alertNumber = Number(envNumber || payloadNumber);
  if (!Number.isInteger(alertNumber) || alertNumber <= 0) {
    fail("Unable to determine secret scanning alert number");
  }
  return alertNumber;
}

async function fetchLocationTarget(location) {
  const { type, details = {} } = location;

  if (type === "issue_body") {
    const issue = await requestJson(details.issue_body_url || details.issue_url);
    return {
      issueNumber: issue.number,
      author: normalizeAuthor(issue.user?.login),
    };
  }

  if (type === "pull_request_body") {
    const pullRequest = await requestJson(
      details.pull_request_body_url || details.pull_request_url,
    );
    return {
      issueNumber: pullRequest.number,
      author: normalizeAuthor(pullRequest.user?.login),
    };
  }

  if (
    type === "issue_comment" ||
    type === "pull_request_comment" ||
    type === "pull_request_review_comment"
  ) {
    const comment = await requestJson(
      details.issue_comment_url ||
        details.pull_request_comment_url ||
        details.pull_request_review_comment_url,
    );
    return {
      issueNumber: extractIssueNumberFromHtmlUrl(comment.html_url),
      author: normalizeAuthor(comment.user?.login),
    };
  }

  return null;
}

async function hasExistingNotification(issueNumber, marker) {
  const comments = await paginateJson(
    `/repos/${repository}/issues/${issueNumber}/comments?per_page=100`,
  );
  return comments.some((comment) => String(comment.body || "").includes(marker));
}

async function createNotification(issueNumber, body) {
  return requestJson(`/repos/${repository}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
}

async function main() {
  if (!token) {
    fail("GITHUB_TOKEN is required");
  }
  if (!repository) {
    fail("SECRET_SCANNING_REPOSITORY or GITHUB_REPOSITORY is required");
  }

  const alertNumber = await fetchAlertNumber();
  const alert = await requestJson(
    `/repos/${repository}/secret-scanning/alerts/${alertNumber}?hide_secret=true`,
  );

  if (alert.state !== "open") {
    console.log(`Skipping alert #${alertNumber}: state=${alert.state}`);
    return;
  }

  const locations = await paginateJson(
    `/repos/${repository}/secret-scanning/alerts/${alertNumber}/locations?per_page=100`,
  );
  const targets = new Map();

  for (const location of locations) {
    const target = await fetchLocationTarget(location);
    if (!target?.issueNumber) {
      console.log(`Skipping unsupported or unresolved location type: ${location.type}`);
      continue;
    }

    const key = String(target.issueNumber);
    if (!targets.has(key)) {
      targets.set(key, {
        issueNumber: target.issueNumber,
        authors: new Set(),
      });
    }
    if (target.author) {
      targets.get(key).authors.add(target.author);
    }
  }

  if (targets.size === 0) {
    console.log(`No supported issue or PR targets found for alert #${alertNumber}`);
    return;
  }

  const marker = `<!-- barnacle-secret-scan:${alertNumber} -->`;
  for (const target of targets.values()) {
    const authors = Array.from(target.authors).toSorted((left, right) => left.localeCompare(right));
    if (await hasExistingNotification(target.issueNumber, marker)) {
      console.log(`Notification already exists for #${target.issueNumber} alert #${alertNumber}`);
      continue;
    }

    const body = buildNotificationBody({ alertNumber, authors });
    await createNotification(target.issueNumber, body);
    console.log(`Posted notification on #${target.issueNumber} for alert #${alertNumber}`);
  }
}

await main();
