#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { runCapitalFreshPaperCandidateCollector } from "./openclaw-capital-fresh-paper-candidate-collector.mjs";

const REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-fresh-paper-candidate-collector-latest.json",
);
const ALLOWED_STATUSES = new Set([
  "candidate_pool_ready_for_same_case_rerun",
  "blocked_failed_replay_rotation_exhausted",
  "blocked_candidate_quality_incomplete",
  "blocked_no_fresh_candidates",
]);

const issues = [];
let report;
try {
  await runCapitalFreshPaperCandidateCollector({
    repoRoot: process.cwd(),
    writeState: true,
  });
  report = JSON.parse(await fs.readFile(REPORT_PATH, "utf8"));
} catch (error) {
  issues.push(`report read failed: ${error instanceof Error ? error.message : String(error)}`);
}

function numberAt(pathName, value) {
  if (!Number.isFinite(Number(value))) {
    issues.push(`${pathName} must be numeric`);
  }
}

if (report) {
  if (report.schema !== "openclaw.capital.fresh-paper-candidate-collector.v1") {
    issues.push("schema mismatch");
  }
  if (!ALLOWED_STATUSES.has(report.status)) {
    issues.push(`status=${report.status}`);
  }
  if (report.source?.noBrokerApiCalled !== true) {
    issues.push("source.noBrokerApiCalled must stay true");
  }
  if (
    report.safetyLock?.paperOnly !== true ||
    report.safetyLock?.noBrokerApiCalled !== true ||
    report.safetyLock?.writeBrokerOrders !== false ||
    report.safetyLock?.brokerWriteAttempted !== false ||
    report.safetyLock?.sentOrder !== false ||
    report.safetyLock?.noLiveOrderSent !== true
  ) {
    issues.push("safetyLock mismatch");
  }
  for (const [key, value] of Object.entries(report.counts ?? {})) {
    numberAt(`counts.${key}`, value);
  }
  if (!report.machineLine?.includes("freshPaperCandidates=")) {
    issues.push("machineLine missing freshPaperCandidates");
  }
  if (!report.machineLine?.includes("noOrderWrite=true")) {
    issues.push("machineLine missing noOrderWrite=true");
  }
  if (
    !Array.isArray(report.selectedReference?.excludedFailedReplaySymbols) ||
    report.selectedReference?.failedReplayQuoteDigestGate?.schema !==
      "openclaw.capital.failed-replay-quote-digest-gate.v1" ||
    report.selectedReference?.failedReplayQuoteDigestGate?.noOrderWrite !== true ||
    report.selectedReference?.failedReplayQuoteDigestGate?.safetyLock?.noLiveOrderSent !== true ||
    typeof report.counts?.failedReplayExcludedCount !== "number" ||
    typeof report.counts?.availableAfterFailedReplayExclusionCount !== "number" ||
    !report.machineLine?.includes("failedReplayExcluded=") ||
    !report.machineLine?.includes("skippedFailedReplay=")
  ) {
    issues.push("failed replay rotation fields missing");
  }
  const quoteDigestGate = report.selectedReference?.failedReplayQuoteDigestGate ?? {};
  if (
    ![
      "lock_active_same_quote_digest",
      "partial_lock_active_quote_digest_gate",
      "unlocked_quote_digest_changed",
      "blocked_legacy_or_stale_baskets_only",
      "clear_no_failed_replay_history",
    ].includes(quoteDigestGate.status) ||
    typeof quoteDigestGate.basketCount !== "number" ||
    typeof quoteDigestGate.activeBasketCount !== "number" ||
    typeof quoteDigestGate.staleBasketCount !== "number" ||
    typeof quoteDigestGate.legacyLockedBasketCount !== "number" ||
    !Array.isArray(quoteDigestGate.activeExcludedSymbols) ||
    !Array.isArray(quoteDigestGate.staleUnlockedSymbols) ||
    !String(quoteDigestGate.machineLine ?? "").includes("failedReplayQuoteDigestGate=")
  ) {
    issues.push(`failedReplayQuoteDigestGate.shape=${JSON.stringify(quoteDigestGate)}`);
  }
  if (report.status === "candidate_pool_ready_for_same_case_rerun") {
    if (Number(report.counts?.selectedCandidateCount ?? 0) <= 0) {
      issues.push("selectedCandidateCount must be positive when ready");
    }
    if (
      Number(report.counts?.crossGroupCandidateCount ?? 0) <= 0 &&
      Number(report.counts?.oppositeCandidateCount ?? 0) <= 0
    ) {
      issues.push("ready report needs cross-group or opposite candidates");
    }
  }
  if (report.status === "blocked_failed_replay_rotation_exhausted") {
    if (Number(report.counts?.selectedCandidateCount ?? 0) !== 0) {
      issues.push("rotation exhausted must not select candidates");
    }
    if (Number(report.counts?.failedReplayExcludedCount ?? 0) <= 0) {
      issues.push("rotation exhausted requires failed replay exclusions");
    }
  }
  for (const candidate of report.selectedCandidates ?? []) {
    if (candidate.freshResolved !== true) {
      issues.push(`candidate ${candidate.symbol} freshResolved mismatch`);
    }
    if (candidate.knownPointValue !== true) {
      issues.push(`candidate ${candidate.symbol} knownPointValue mismatch`);
    }
    if (candidate.paperOnly !== true) {
      issues.push(`candidate ${candidate.symbol} paperOnly mismatch`);
    }
    if (candidate.crossGroupProxy !== true && candidate.oppositeExposure !== true) {
      issues.push(`candidate ${candidate.symbol} lacks cross-group/opposite evidence`);
    }
    if (candidate.failedReplayExcluded === true) {
      issues.push(`candidate ${candidate.symbol} is failed replay excluded`);
    }
  }
  if (!report.nextCommand || !report.nextSafeTask) {
    issues.push("next command/task missing");
  }
}

if (issues.length > 0) {
  process.stderr.write(`CAPITAL_FRESH_PAPER_CANDIDATES_CHECK=FAIL ${issues.join("; ")}\n`);
  process.exit(1);
}

process.stdout.write(
  `CAPITAL_FRESH_PAPER_CANDIDATES_CHECK=OK status=${report.status} selected=${report.counts.selectedCandidateCount} crossGroup=${report.counts.crossGroupCandidateCount} opposite=${report.counts.oppositeCandidateCount} noLiveOrderSent=${report.safetyLock.noLiveOrderSent}\n`,
);
