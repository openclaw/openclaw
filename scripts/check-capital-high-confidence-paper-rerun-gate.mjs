#!/usr/bin/env node
// Verifies the paper-only high-confidence Capital rerun gate.
import { buildHighConfidencePaperRerunGate } from "./openclaw-capital-high-confidence-paper-rerun-gate.mjs";

const result = await buildHighConfidencePaperRerunGate({ repoRoot: process.cwd() });
const issues = [];

if (result.schema !== "openclaw.capital.high-confidence-paper-rerun-gate.v1") {
  issues.push(`schema=${result.schema ?? ""}`);
}

if (
  ![
    "high_confidence_candidate_tail_passed_requires_promotion_rerun",
    "high_confidence_rerun_completed_still_blocked",
    "blocked_no_high_confidence_candidate",
  ].includes(result.status)
) {
  issues.push(`status=${result.status ?? ""}`);
}

if (
  !result.safetyLock?.paperOnly ||
  !result.safetyLock?.simulatedOnly ||
  result.safetyLock?.liveTradingEnabled ||
  result.safetyLock?.writeBrokerOrders ||
  result.safetyLock?.sentOrder ||
  !result.safetyLock?.noLiveOrderSent ||
  !result.noOrderWrite
) {
  issues.push(`safety=${JSON.stringify(result.safetyLock)}`);
}

if (
  typeof result.confidenceGate?.threshold !== "number" ||
  result.confidenceGate.threshold < 0.6 ||
  ![
    "impossible_under_current_signal_model",
    "reachable_if_signal_improves",
    "not_reported",
  ].includes(result.confidenceGate?.requiredConfidenceStatus) ||
  typeof result.candidateCount !== "number" ||
  typeof result.passCount !== "number" ||
  typeof result.blockedCount !== "number" ||
  !Array.isArray(result.blockers) ||
  !Array.isArray(result.candidates) ||
  !Array.isArray(result.reruns) ||
  !(result.machineLine ?? "").includes("highConfidencePaperRerun=") ||
  !(result.machineLine ?? "").includes("noOrderWrite=true")
) {
  issues.push("shape=invalid");
}

for (const candidate of result.candidates ?? []) {
  if (
    !candidate.noOrderWrite ||
    typeof candidate.confidence !== "number" ||
    candidate.confidence < result.confidenceGate.threshold ||
    candidate.sourceFreshnessStatus !== "fresh" ||
    !(candidate.intentPath ?? "").includes("capital-high-confidence-paper-rerun/")
  ) {
    issues.push(`candidate=${JSON.stringify(candidate)}`);
  }
}

for (const rerun of result.reruns ?? []) {
  if (
    !["high_confidence_tail_passed", "high_confidence_tail_still_blocked"].includes(rerun.status) ||
    rerun.safetyLock?.writeBrokerOrders ||
    rerun.safetyLock?.sentOrder ||
    !rerun.safetyLock?.noLiveOrderSent ||
    !rerun.noOrderWrite ||
    typeof rerun.p05TotalPnlPts !== "number" ||
    typeof rerun.p05TotalPnlNotional !== "number"
  ) {
    issues.push(`rerun=${JSON.stringify(rerun)}`);
  }
}

if (result.candidateCount > 0 && result.reruns.length !== result.candidateCount) {
  issues.push(`rerunCount=${result.reruns.length};candidateCount=${result.candidateCount}`);
}

if (
  result.status === "high_confidence_candidate_tail_passed_requires_promotion_rerun" &&
  result.passCount <= 0
) {
  issues.push("passCount=0");
}

if (issues.length > 0) {
  process.stderr.write(`CAPITAL_HIGH_CONFIDENCE_PAPER_RERUN_CHECK=FAIL ${issues.join("; ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `CAPITAL_HIGH_CONFIDENCE_PAPER_RERUN_CHECK=OK status=${result.status} candidates=${result.candidateCount} pass=${result.passCount} noLiveOrderSent=${result.safetyLock.noLiveOrderSent}\n`,
  );
}
