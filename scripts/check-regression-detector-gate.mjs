#!/usr/bin/env node
import { readFileSync, appendFileSync } from "node:fs";

const eventPath = process.env.GITHUB_EVENT_PATH;
const summaryPath = process.env.GITHUB_STEP_SUMMARY;

const writeSummary = (message) => {
  if (summaryPath) {
    appendFileSync(summaryPath, `${message}\n`);
  }
};

const payload = eventPath ? JSON.parse(readFileSync(eventPath, "utf8")) : {};
const pr = payload.pull_request ?? {};
const labels = new Set((pr.labels ?? []).map((label) => String(label.name ?? label).toLowerCase()));
const title = String(pr.title ?? "");
const body = String(pr.body ?? "");
const combined = `${title}\n${body}`.toLowerCase();

const isBugFix =
  /(^|\b)(fix|bugfix|hotfix|defect|regression)(\b|:)/i.test(title) ||
  ["bug", "bugfix", "hotfix", "defect", "regression"].some((label) => labels.has(label));

if (!isBugFix) {
  console.log("Not flagged as a bug-fix PR; skipping regression detector gate.");
  writeSummary("Not flagged as a bug-fix PR; skipping regression detector gate.");
  process.exit(0);
}

const requiredPatterns = [
  {
    name: "pre-fix failure/reproduction evidence",
    pattern: /(pre[- ]?fix|repro(?:duction)?).*(fail|evidence|command)/is,
  },
  {
    name: "post-fix verification evidence",
    pattern: /(post[- ]?fix|verification|fixed).*(pass|success|command)/is,
  },
  {
    name: "regression test evidence",
    pattern: /(regression|test).*(pass|coverage|guard|command)/is,
  },
];
const missing = requiredPatterns
  .filter(({ pattern }) => !pattern.test(body))
  .map(({ name }) => name);

const tradingSensitive = /\b(kalshi|polymarket|trade|trading|position|order|risk|scanner)\b/i.test(
  combined,
);
if (tradingSensitive && !labels.has("risk-officer-approved")) {
  missing.push("risk-officer-approved label for trading-sensitive bug-fix PR");
}

if (missing.length > 0) {
  console.error("Regression detector gate failed; missing required evidence:");
  for (const item of missing) {
    console.error(`- ${item}`);
  }
  writeSummary("Regression detector gate failed; missing required evidence:");
  for (const item of missing) {
    writeSummary(`- ${item}`);
  }
  process.exit(1);
}

console.log(`PR classified as bug-fix: ${title}`);
console.log("Required regression evidence fields and checkboxes are present.");
writeSummary(`PR classified as bug-fix: ${title}`);
writeSummary("Required regression evidence fields and checkboxes are present.");
