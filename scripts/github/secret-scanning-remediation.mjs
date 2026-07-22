#!/usr/bin/env node

// GitHub secret-scanning remediation workflow helper.
//
// Definition:
//   plan: fetches a secret-scanning alert with hide_secret=true, classifies
//   locations, and emits sanitized workflow outputs for environment approval.
//   remediate: after protected-environment approval, redacts supported body
//   locations or deletes/recreates supported issue comments, then resolves the
//   alert. Commit and review-comment locations stay manual.
//
// Parameters:
//   --mode <plan|remediate> or OPENCLAW_SECRET_SCAN_MODE.
//   --alert <number> or OPENCLAW_SECRET_SCAN_ALERT_NUMBER / event payload.
//   GITHUB_TOKEN and GITHUB_REPOSITORY are required for API calls.
//
// Outputs:
//   plan writes remediation-action and remediation-summary to GITHUB_OUTPUT.
//   stdout contains sanitized status only; never plaintext body or secrets.
//
// Examples:
//   OPENCLAW_SECRET_SCAN_MODE=plan node scripts/github/secret-scanning-remediation.mjs
//   node scripts/github/secret-scanning-remediation.mjs --mode remediate --alert 123

import fs from "node:fs";
import process from "node:process";

export const supportedLocationTypes = new Set(["issue_body", "pull_request_body", "issue_comment"]);

const apiBaseUrl = process.env.OPENCLAW_SECRET_SCAN_API_BASE_URL || "https://api.github.com";
const redactionPrefix = "[REDACTED ";

function usage() {
  return `Usage:
  node scripts/github/secret-scanning-remediation.mjs --mode <plan|remediate> [--alert <number>]

Description:
  Plans and performs approved OpenClaw secret-scanning remediation. The plan
  phase never reads plaintext secrets and never changes GitHub content. The
  remediate phase is intended to run only behind the secret-remediation
  protected environment approval gate.

Options:
  --mode <plan|remediate>  Required unless OPENCLAW_SECRET_SCAN_MODE is set.
  --alert <number>         Alert number; otherwise read from env or event JSON.
  -h, --help               Show this help.

Outputs:
  plan: GitHub Actions outputs remediation-action and remediation-summary.
  remediate: sanitized JSON status on stdout and private alert resolution.

Examples:
  node scripts/github/secret-scanning-remediation.mjs --mode plan --alert 123
  OPENCLAW_SECRET_SCAN_MODE=remediate node scripts/github/secret-scanning-remediation.mjs
`;
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const args = {
    alertNumber: null,
    mode: process.env.OPENCLAW_SECRET_SCAN_MODE || null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      return { ...args, help: true };
    }
    if (arg === "--mode") {
      args.mode = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--alert") {
      args.alertNumber = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }
  return args;
}

function normalizeApiUrl(urlOrPath) {
  if (!urlOrPath) {
    fail("Missing API URL");
  }
  if (urlOrPath.startsWith("https://")) {
    return urlOrPath;
  }
  if (urlOrPath.startsWith("/")) {
    return `${apiBaseUrl}${urlOrPath}`;
  }
  return `${apiBaseUrl}/${urlOrPath}`;
}

function apiPathForLog(url) {
  return String(url).replace(apiBaseUrl, "");
}

async function requestJson(urlOrPath, init = {}, env = process.env) {
  const url = normalizeApiUrl(urlOrPath);
  const token = env.GITHUB_TOKEN;
  if (!token) {
    fail("GITHUB_TOKEN is required");
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
    fail(
      `GitHub API request failed: ${response.status} ${response.statusText} ${apiPathForLog(url)}`,
    );
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

async function paginateJson(urlOrPath, env = process.env) {
  const items = [];
  let nextUrl = normalizeApiUrl(urlOrPath);
  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      fail(
        `GitHub API request failed: ${response.status} ${response.statusText} ${apiPathForLog(nextUrl)}`,
      );
    }
    const page = await response.json();
    items.push(...(Array.isArray(page) ? page : [page]));
    const linkHeader = response.headers.get("link") || "";
    nextUrl = linkHeader.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  }
  return items;
}

function parseEventPayload(env = process.env) {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    return {};
  }
  return JSON.parse(fs.readFileSync(eventPath, "utf8"));
}

function resolveAlertNumber(args, env = process.env) {
  if (Number.isInteger(args.alertNumber) && args.alertNumber > 0) {
    return args.alertNumber;
  }
  const payload = parseEventPayload(env);
  const value =
    env.OPENCLAW_SECRET_SCAN_ALERT_NUMBER ||
    env.SECRET_SCANNING_ALERT_NUMBER ||
    payload?.alert?.number ||
    payload?.number;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    fail("Unable to determine secret scanning alert number");
  }
  return number;
}

function normalizeLogin(login) {
  return typeof login === "string" && login.length > 0 && !login.endsWith("[bot]") ? login : null;
}

function extractIssueNumberFromHtmlUrl(htmlUrl) {
  const match = String(htmlUrl || "").match(/\/(?:issues|pull)\/(\d+)/u);
  return match ? Number(match[1]) : null;
}

function targetSummary(target) {
  const author = target.author ? `author=@${target.author}` : "author=unknown";
  return `${target.locationType}:${target.operation}:${author}`;
}

function outputValue(value) {
  return String(value)
    .replace(/[\r\n]/gu, " ")
    .slice(0, 1024);
}

function setGithubOutput(name, value, env = process.env) {
  if (!env.GITHUB_OUTPUT) {
    return;
  }
  fs.appendFileSync(env.GITHUB_OUTPUT, `${name}=${outputValue(value)}\n`);
}

function redactionMarker(secretType) {
  return `${redactionPrefix}${String(secretType || "Secret")}]`;
}

function isAlreadyRedacted(value) {
  return String(value).includes(redactionPrefix);
}

export function redactLocationRange(body, details, secretType) {
  const startLine = Number(details.start_line);
  const endLine = Number(details.end_line);
  const startColumn = Number(details.start_column);
  const endColumn = Number(details.end_column);
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    !Number.isInteger(startColumn) ||
    !Number.isInteger(endColumn) ||
    startLine <= 0 ||
    endLine < startLine ||
    startColumn <= 0 ||
    endColumn <= 0
  ) {
    return { changed: false, reason: "invalid_location_range", text: body };
  }

  const lines = String(body ?? "").split("\n");
  if (startLine > lines.length || endLine > lines.length) {
    return { changed: false, reason: "location_out_of_range", text: body };
  }

  const startIndex = startColumn - 1;
  const endIndex = endColumn - 1;
  const firstLine = lines[startLine - 1] ?? "";
  const lastLine = lines[endLine - 1] ?? "";
  if (startIndex > firstLine.length || endIndex > lastLine.length) {
    return { changed: false, reason: "column_out_of_range", text: body };
  }

  const selected =
    startLine === endLine
      ? firstLine.slice(startIndex, endIndex)
      : [
          firstLine.slice(startIndex),
          ...lines.slice(startLine, endLine - 1),
          lastLine.slice(0, endIndex),
        ].join("\n");
  if (selected.length === 0) {
    return { changed: false, reason: "empty_location_range", text: body };
  }
  if (isAlreadyRedacted(selected)) {
    return { changed: false, reason: "already_redacted", text: body };
  }

  const marker = redactionMarker(secretType);
  if (startLine === endLine) {
    lines[startLine - 1] = `${firstLine.slice(0, startIndex)}${marker}${firstLine.slice(endIndex)}`;
  } else {
    lines.splice(
      startLine - 1,
      endLine - startLine + 1,
      `${firstLine.slice(0, startIndex)}${marker}${lastLine.slice(endIndex)}`,
    );
  }
  return { changed: true, text: lines.join("\n") };
}

function rangeStart(details) {
  return {
    column: Number(details.start_column),
    line: Number(details.start_line),
  };
}

function compareRangeDescending(left, right) {
  const leftStart = rangeStart(left);
  const rightStart = rangeStart(right);
  return rightStart.line - leftStart.line || rightStart.column - leftStart.column;
}

export function redactLocationRanges(body, detailsList, secretType) {
  let text = String(body ?? "");
  let changed = false;
  let alreadyRedacted = 0;
  const sortedDetails = detailsList.toSorted(compareRangeDescending);

  for (const details of sortedDetails) {
    const redaction = redactLocationRange(text, details, secretType);
    if (!redaction.changed) {
      if (redaction.reason === "already_redacted") {
        alreadyRedacted += 1;
        continue;
      }
      return {
        changed: false,
        ok: false,
        reason: redaction.reason,
        text: body,
      };
    }
    changed = true;
    text = redaction.text;
  }

  return {
    changed,
    ok: true,
    reason: changed ? undefined : alreadyRedacted > 0 ? "already_redacted" : "empty_locations",
    text,
  };
}

async function fetchAlert(alertNumber, env) {
  const repository = env.GITHUB_REPOSITORY;
  if (!repository) {
    fail("GITHUB_REPOSITORY is required");
  }
  return requestJson(
    `/repos/${repository}/secret-scanning/alerts/${alertNumber}?hide_secret=true`,
    {},
    env,
  );
}

async function fetchLocations(alertNumber, env) {
  return paginateJson(
    `/repos/${env.GITHUB_REPOSITORY}/secret-scanning/alerts/${alertNumber}/locations?per_page=100`,
    env,
  );
}

async function classifyLocation(location, env) {
  const details = location.details ?? {};
  if (location.type === "issue_body") {
    const issue = await requestJson(details.issue_body_url || details.issue_url, {}, env);
    return {
      author: normalizeLogin(issue?.user?.login),
      bodyEndpoint: `/repos/${env.GITHUB_REPOSITORY}/issues/${issue.number}`,
      locationType: location.type,
      operation: "patch_body",
      details,
    };
  }
  if (location.type === "pull_request_body") {
    const pullRequest = await requestJson(
      details.pull_request_body_url || details.pull_request_url,
      {},
      env,
    );
    return {
      author: normalizeLogin(pullRequest?.user?.login),
      bodyEndpoint: `/repos/${env.GITHUB_REPOSITORY}/pulls/${pullRequest.number}`,
      locationType: location.type,
      operation: "patch_body",
      details,
    };
  }
  if (location.type === "issue_comment") {
    const comment = await requestJson(details.issue_comment_url, {}, env);
    return {
      author: normalizeLogin(comment?.user?.login),
      commentDeleteEndpoint: `/repos/${env.GITHUB_REPOSITORY}/issues/comments/${comment.id}`,
      commentId: comment.id,
      issueNumber: extractIssueNumberFromHtmlUrl(comment?.html_url),
      locationType: location.type,
      operation: "delete_recreate_comment",
      details,
    };
  }
  return {
    locationType: location.type,
    operation: location.type === "commit" ? "manual_rotate_commit" : "manual_review",
    unsupported: true,
  };
}

export async function buildRemediationPlan({ alertNumber, env = process.env }) {
  const alert = await fetchAlert(alertNumber, env);
  if (alert.state !== "open") {
    return {
      action: "none",
      reason: `alert_state_${alert.state}`,
      summary: `No remediation needed; alert state is ${alert.state}.`,
      targets: [],
    };
  }

  const locations = await fetchLocations(alertNumber, env);
  const targets = [];
  for (const location of locations) {
    targets.push(await classifyLocation(location, env));
  }
  if (targets.length === 0) {
    return {
      action: "manual",
      reason: "no_locations",
      summary: "No alert locations returned; maintainer review required.",
      targets,
    };
  }

  const unsupportedTargets = targets.filter((target) => target.unsupported);
  if (unsupportedTargets.length > 0) {
    return {
      action: "manual",
      reason: "unsupported_location",
      summary: `Manual remediation required for ${unsupportedTargets
        .map((target) => target.locationType)
        .toSorted()
        .join(", ")}.`,
      targets,
    };
  }

  return {
    action: "approval-required",
    reason: "supported_locations",
    summary: `Maintainer approval required for ${targets.map(targetSummary).join("; ")}`,
    targets,
  };
}

function groupTargets(targets, keyForTarget) {
  const groups = new Map();
  for (const target of targets) {
    const key = keyForTarget(target);
    if (!key) {
      continue;
    }
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(target);
  }
  return [...groups.values()];
}

async function patchBodyTargets({ targets, alert, env }) {
  const target = targets[0];
  const resource = await requestJson(target.bodyEndpoint, {}, env);
  const redaction = redactLocationRanges(
    resource?.body ?? "",
    targets.map((item) => item.details),
    alert.secret_type_display_name,
  );
  if (!redaction.ok || !redaction.changed) {
    return {
      changed: false,
      locationType: target.locationType,
      operation: target.operation,
      reason: redaction.reason,
    };
  }
  await requestJson(
    target.bodyEndpoint,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: redaction.text }),
    },
    env,
  );
  return { changed: true, locationType: target.locationType, operation: target.operation };
}

function replacementCommentBody({ author, originalBody }) {
  const attribution = author ? ` by @${author}` : "";
  return [
    `> **Note:** The original comment${attribution} was removed because it contained sensitive credentials. The redacted content is preserved below.`,
    "",
    "---",
    "",
    originalBody,
  ].join("\n");
}

async function remediateIssueCommentTargets({ targets, alert, env }) {
  const target = targets[0];
  if (!target.issueNumber) {
    return {
      changed: false,
      locationType: target.locationType,
      operation: target.operation,
      reason: "missing_issue_number",
    };
  }
  const comment = await requestJson(
    `/repos/${env.GITHUB_REPOSITORY}/issues/comments/${target.commentId}`,
    {},
    env,
  );
  const redaction = redactLocationRanges(
    comment?.body ?? "",
    targets.map((item) => item.details),
    alert.secret_type_display_name,
  );
  if (!redaction.ok || !redaction.changed) {
    return {
      changed: false,
      locationType: target.locationType,
      operation: target.operation,
      reason: redaction.reason,
    };
  }
  await requestJson(target.commentDeleteEndpoint, { method: "DELETE" }, env);
  await requestJson(
    `/repos/${env.GITHUB_REPOSITORY}/issues/${target.issueNumber}/comments`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: replacementCommentBody({
          author: target.author,
          originalBody: redaction.text,
        }),
      }),
    },
    env,
  );
  return { changed: true, locationType: target.locationType, operation: target.operation };
}

function isSuccessfulRemediationResult(result) {
  return result.changed === true || result.reason === "already_redacted";
}

async function resolveAlert(alertNumber, results, env) {
  const changedCount = results.filter((result) => result.changed).length;
  const resolutionComment =
    changedCount > 0
      ? "Approved maintainer remediation completed; exposed credentials must be considered compromised and rotated."
      : "Approved maintainer remediation found no remaining plaintext at the current location; credentials must still be considered compromised and rotated.";
  await requestJson(
    `/repos/${env.GITHUB_REPOSITORY}/secret-scanning/alerts/${alertNumber}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: "resolved",
        resolution: "revoked",
        resolution_comment: resolutionComment,
      }),
    },
    env,
  );
}

export async function remediateAlert({ alertNumber, env = process.env }) {
  const plan = await buildRemediationPlan({ alertNumber, env });
  if (plan.action !== "approval-required") {
    return { ok: true, skipped: true, reason: plan.reason, results: [] };
  }

  const alert = await fetchAlert(alertNumber, env);
  const results = [];
  for (const targets of groupTargets(
    plan.targets.filter((target) => target.operation === "patch_body"),
    (target) => target.bodyEndpoint,
  )) {
    results.push(await patchBodyTargets({ targets, alert, env }));
  }
  for (const targets of groupTargets(
    plan.targets.filter((target) => target.operation === "delete_recreate_comment"),
    (target) => String(target.commentId),
  )) {
    results.push(await remediateIssueCommentTargets({ targets, alert, env }));
  }
  const failedResult = results.find((result) => !isSuccessfulRemediationResult(result));
  if (failedResult) {
    fail(
      `Secret scanning remediation incomplete for ${failedResult.locationType}: ${failedResult.reason}`,
    );
  }
  await resolveAlert(alertNumber, results, env);
  return { ok: true, skipped: false, results };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (args.mode !== "plan" && args.mode !== "remediate") {
    fail("--mode must be plan or remediate");
  }
  const alertNumber = resolveAlertNumber(args);

  if (args.mode === "plan") {
    const plan = await buildRemediationPlan({ alertNumber });
    setGithubOutput("remediation-action", plan.action);
    setGithubOutput("remediation-summary", plan.summary);
    console.log(
      JSON.stringify({ action: plan.action, reason: plan.reason, summary: plan.summary }),
    );
    return;
  }

  const result = await remediateAlert({ alertNumber });
  console.log(JSON.stringify(result));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
