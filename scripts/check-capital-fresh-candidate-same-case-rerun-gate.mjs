#!/usr/bin/env node
// Verifies the paper-only fresh candidate same-case rerun gate.
import {
  buildFreshCandidateSameCaseRerunGate,
  writeFreshCandidateSameCaseRerunGate,
} from "./openclaw-capital-fresh-candidate-same-case-rerun-gate.mjs";

const result = await buildFreshCandidateSameCaseRerunGate({ repoRoot: process.cwd() });
await writeFreshCandidateSameCaseRerunGate(result);
const issues = [];

if (result.schema !== "openclaw.capital.fresh-candidate-same-case-rerun-gate.v1") {
  issues.push(`schema=${result.schema ?? ""}`);
}

if (
  ![
    "fresh_candidate_same_case_tail_passed_requires_promotion_rerun",
    "fresh_candidate_same_case_rerun_completed_still_blocked",
    "blocked_no_fresh_candidate_batch",
  ].includes(result.status)
) {
  issues.push(`status=${result.status ?? ""}`);
}

if (
  result.safetyLock?.paperOnly !== true ||
  result.safetyLock?.simulatedOnly !== true ||
  result.safetyLock?.liveTradingEnabled !== false ||
  result.safetyLock?.writeBrokerOrders !== false ||
  result.safetyLock?.sentOrder !== false ||
  result.safetyLock?.noLiveOrderSent !== true ||
  result.noOrderWrite !== true
) {
  issues.push(`safety=${JSON.stringify(result.safetyLock)}`);
}

if (
  typeof result.selectedCandidateCount !== "number" ||
  typeof result.rerunIntentCount !== "number" ||
  typeof result.passCount !== "number" ||
  typeof result.blockedCount !== "number" ||
  !Array.isArray(result.blockers) ||
  !Array.isArray(result.candidates) ||
  !String(result.machineLine ?? "").includes("freshCandidateSameCaseRerun=") ||
  !String(result.machineLine ?? "").includes("noOrderWrite=true")
) {
  issues.push("shape=invalid");
}

for (const candidate of result.candidates ?? []) {
  if (
    candidate.noOrderWrite !== true ||
    candidate.freshResolved !== true ||
    candidate.knownPointValue !== true ||
    (candidate.crossGroupProxy !== true && candidate.oppositeExposure !== true)
  ) {
    issues.push(`candidate=${JSON.stringify(candidate)}`);
  }
}

if (result.rerun) {
  if (
    ![
      "fresh_candidate_same_case_tail_passed",
      "fresh_candidate_same_case_tail_still_blocked",
    ].includes(result.rerun.status) ||
    result.rerun.safetyLock?.writeBrokerOrders !== false ||
    result.rerun.safetyLock?.sentOrder !== false ||
    result.rerun.safetyLock?.noLiveOrderSent !== true ||
    result.rerun.noOrderWrite !== true ||
    typeof result.rerun.p05TotalPnlPts !== "number" ||
    typeof result.rerun.p05TotalPnlNotional !== "number"
  ) {
    issues.push(`rerun=${JSON.stringify(result.rerun)}`);
  }
}

if (result.rerunIntentCount > 0 && !result.rerun) {
  issues.push("rerun missing");
}

if (
  result.status === "fresh_candidate_same_case_tail_passed_requires_promotion_rerun" &&
  result.passCount <= 0
) {
  issues.push("passCount=0");
}

if (issues.length > 0) {
  process.stderr.write(`CAPITAL_FRESH_CANDIDATE_SAME_CASE_RERUN_CHECK=FAIL ${issues.join("; ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `CAPITAL_FRESH_CANDIDATE_SAME_CASE_RERUN_CHECK=OK status=${result.status} candidates=${result.rerunIntentCount} pass=${result.passCount} noLiveOrderSent=${result.safetyLock.noLiveOrderSent}\n`,
  );
}
