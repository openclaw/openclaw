#!/usr/bin/env node
import { readFileSync, appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function normalizeRegressionGateLabels(pr) {
  return new Set((pr.labels ?? []).map((label) => String(label.name ?? label).toLowerCase()));
}

export function isBugFixPullRequest(pr) {
  const labels = normalizeRegressionGateLabels(pr);
  const title = String(pr.title ?? "");
  return (
    /(^|\b)(fix|bugfix|hotfix|defect|regression)(\b|:)/i.test(title) ||
    ["bug", "bugfix", "hotfix", "defect", "regression"].some((label) => labels.has(label))
  );
}

export function isTradingSensitiveBugFix(pr) {
  const title = String(pr.title ?? "");
  const body = String(pr.body ?? "");
  const combined = `${title}\n${body}`;
  return (
    /\b(kalshi|polymarket|trading|trade execution|trade placement|position sizing|open positions?|live orders?|paper orders?|stop[- ]loss|take[- ]profit|risk mode|risk officer|risk limits?)\b/i.test(
      combined,
    ) ||
    /\b(?:trading|ws)\s+scanner\b|\bscanner\s+(?:entry|exit|trade|trading|order|position)\b/i.test(
      combined,
    )
  );
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

export function evaluateRegressionDetectorGate(pr) {
  const labels = normalizeRegressionGateLabels(pr);
  const body = String(pr.body ?? "");
  if (!isBugFixPullRequest(pr)) {
    return {
      skipped: true,
      missing: [],
      message: "Not flagged as a bug-fix PR; skipping regression detector gate.",
    };
  }

  const missing = requiredPatterns
    .filter(({ pattern }) => !pattern.test(body))
    .map(({ name }) => name);

  if (isTradingSensitiveBugFix(pr) && !labels.has("risk-officer-approved")) {
    missing.push("risk-officer-approved label for trading-sensitive bug-fix PR");
  }

  return {
    skipped: false,
    missing,
    message:
      missing.length > 0
        ? "Regression detector gate failed; missing required evidence:"
        : `PR classified as bug-fix: ${String(pr.title ?? "")}`,
  };
}

function runCli() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  const writeSummary = (message) => {
    if (summaryPath) {
      appendFileSync(summaryPath, `${message}\n`);
    }
  };

  const payload = eventPath ? JSON.parse(readFileSync(eventPath, "utf8")) : {};
  const pr = payload.pull_request ?? {};
  const evaluation = evaluateRegressionDetectorGate(pr);

  if (evaluation.skipped) {
    console.log(evaluation.message);
    writeSummary(evaluation.message);
    process.exit(0);
  }

  if (evaluation.missing.length > 0) {
    console.error(evaluation.message);
    for (const item of evaluation.missing) {
      console.error(`- ${item}`);
    }
    writeSummary(evaluation.message);
    for (const item of evaluation.missing) {
      writeSummary(`- ${item}`);
    }
    process.exit(1);
  }

  console.log(evaluation.message);
  console.log("Required regression evidence fields and checkboxes are present.");
  writeSummary(evaluation.message);
  writeSummary("Required regression evidence fields and checkboxes are present.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
