#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-public-strategy-intake-latest.json",
);

const issues = [];
let report;

try {
  report = JSON.parse(await fs.readFile(REPORT_PATH, "utf8"));
} catch (error) {
  issues.push(`report read failed: ${error instanceof Error ? error.message : String(error)}`);
}

if (report) {
  if (report.schema !== "openclaw.capital.public-strategy-intake.v1") {
    issues.push("schema mismatch");
  }
  if (report.status !== "strategy_candidates_generated") {
    issues.push(`status=${report.status}`);
  }
  if (!Array.isArray(report.publicSources) || report.publicSources.length < 5) {
    issues.push("public source coverage missing");
  }
  if (!report.publicSources?.some((source) => source.kind === "discussion_forum")) {
    issues.push("discussion source missing");
  }
  if (!Array.isArray(report.strategyCandidates) || report.strategyCandidates.length < 1) {
    issues.push("strategy candidates missing");
  }
  for (const candidate of report.strategyCandidates ?? []) {
    if (candidate.noOrderWrite !== true || candidate.noLiveOrderSent !== true) {
      issues.push(`candidate safety mismatch: ${candidate.id ?? "unknown"}`);
    }
    if (typeof candidate.nextValidationCommand !== "string" || !candidate.nextValidationCommand) {
      issues.push(`candidate validation missing: ${candidate.id ?? "unknown"}`);
    }
    if (!Array.isArray(candidate.sourceBasis) || candidate.sourceBasis.length === 0) {
      issues.push(`candidate source basis missing: ${candidate.id ?? "unknown"}`);
    }
  }
  if (
    report.safety?.paperOnly !== true ||
    report.safety?.liveTradingEnabled !== false ||
    report.safety?.writeBrokerOrders !== false ||
    report.safety?.brokerWriteAttempted !== false ||
    report.safety?.sentOrder !== false ||
    report.safety?.noOrderWrite !== true
  ) {
    issues.push("safety lock mismatch");
  }
  if (report.reasoningPolicy?.discussionSourcesAreHypothesisOnly !== true) {
    issues.push("discussion source guard missing");
  }
  if (!report.paths?.reportPath || !report.paths?.markdownPath) {
    issues.push("paths missing");
  }
}

if (issues.length > 0) {
  process.stderr.write(`CAPITAL_PUBLIC_STRATEGY_INTAKE_CHECK=FAIL ${issues.join("; ")}\n`);
  process.exit(1);
}

process.stdout.write(
  `CAPITAL_PUBLIC_STRATEGY_INTAKE_CHECK=OK status=${report.status} candidates=${report.strategyCandidates.length} sources=${report.publicSources.length} noOrderWrite=${report.safety.noOrderWrite}\n`,
);
