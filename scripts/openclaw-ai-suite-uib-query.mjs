#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

async function readJson(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "EISDIR") {
      return null;
    }
    throw error;
  }
}

function buildBlockers(quoteStatus, sourceVetting) {
  const blockers = [];
  if (
    quoteStatus?.status === "stale" ||
    quoteStatus?.quoteProof?.freshnessStatus === "stale" ||
    quoteStatus?.ready === false
  ) {
    blockers.push("quote_freshness_stale");
  }
  if (
    quoteStatus?.session?.tradingOpen === false ||
    quoteStatus?.session?.marketSession === "closed"
  ) {
    blockers.push("market_session_closed");
  }
  if (sourceVetting?.summary?.source_vetting_status === "manual_review_required") {
    blockers.push("source_vetting_manual_review_required");
  }
  return [...new Set(blockers)];
}

function extractNextSafeTask(runnerReport) {
  const value = runnerReport?.next_safe_task;
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && typeof value.id === "string") {
    return value.id;
  }
  return "";
}

async function main() {
  const repoRoot = process.cwd();
  const quoteStatusPath = path.join(repoRoot, ".openclaw", "quote", "capital-quote-status.json");
  const sourceVettingPath = path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-skill-source-vetting-latest.json",
  );
  const runnerReportPath = path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-controlled-task-runner-latest.json",
  );

  const quoteStatus = await readJson(quoteStatusPath);
  const sourceVetting = await readJson(sourceVettingPath);
  const runnerReport = await readJson(runnerReportPath);

  const blockers = buildBlockers(quoteStatus, sourceVetting);
  const report = {
    schema: "openclaw.ai-suite.uib.query.v1",
    generatedAt: new Date().toISOString(),
    readOnlyMode: true,
    core_result: "success",
    changed_files: [],
    validation_result: {
      quote_status: quoteStatus?.status ?? "unknown",
      market_session: quoteStatus?.session?.marketSession ?? "unknown",
      trading_open:
        typeof quoteStatus?.session?.tradingOpen === "boolean"
          ? quoteStatus.session.tradingOpen
          : null,
      source_vetting_status: sourceVetting?.summary?.source_vetting_status ?? "unknown",
    },
    remaining_blockers: blockers,
    next_safe_task: extractNextSafeTask(runnerReport),
    risk: "read-only status query; no broker writes and no third-party execution",
  };

  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(`UIB_QUERY status=${report.validation_result.quote_status}\n`);
  process.stdout.write(`market_session=${report.validation_result.market_session}\n`);
  process.stdout.write(`source_vetting=${report.validation_result.source_vetting_status}\n`);
  process.stdout.write(`blockers=${report.remaining_blockers.join(",") || "none"}\n`);
  process.stdout.write(`next_safe_task=${report.next_safe_task || "none"}\n`);
}

await main().catch((error) => {
  process.stderr.write(
    `openclaw-ai-suite-uib-query failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
