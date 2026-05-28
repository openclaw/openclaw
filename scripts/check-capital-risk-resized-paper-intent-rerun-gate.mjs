#!/usr/bin/env node
// Verifies the paper-only risk-resized Capital strategy rerun gate.
import { buildRiskResizedPaperIntentRerunGate } from "./openclaw-capital-risk-resized-paper-intent-rerun-gate.mjs";

const result = await buildRiskResizedPaperIntentRerunGate({ repoRoot: process.cwd() });
const issues = [];

if (result.schema !== "openclaw.capital.risk-resized-paper-intent-rerun-gate.v1") {
  issues.push(`schema=${result.schema ?? ""}`);
}

if (
  ![
    "paper_resized_candidate_tail_passed_requires_promotion_rerun",
    "paper_resized_rerun_completed_still_blocked",
    "blocked_no_rerun_ready",
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
  typeof result.resizedCandidateCount !== "number" ||
  typeof result.passCount !== "number" ||
  typeof result.blockedCount !== "number" ||
  !Array.isArray(result.blockers) ||
  !Array.isArray(result.resizedCandidates) ||
  !Array.isArray(result.reruns) ||
  !result.rejectionSummary ||
  result.rejectionSummary.schema !== "openclaw.capital.risk-resized-paper-rejection-summary.v1" ||
  !String(result.machineLine ?? "").includes("riskResizedPaperRerun=") ||
  !String(result.machineLine ?? "").includes("rejectionSummary=") ||
  !String(result.machineLine ?? "").includes("noOrderWrite=true")
) {
  issues.push("shape=invalid");
}

if (
  result.rejectionSummary?.safetyLock?.writeBrokerOrders !== false ||
  result.rejectionSummary?.safetyLock?.sentOrder !== false ||
  result.rejectionSummary?.safetyLock?.noLiveOrderSent !== true ||
  result.rejectionSummary?.noOrderWrite !== true ||
  typeof result.rejectionSummary?.machineLine !== "string" ||
  !result.rejectionSummary.machineLine.includes("riskResizedRejectionSummary=") ||
  !result.rejectionSummary.machineLine.includes("noOrderWrite=true")
) {
  issues.push(`rejectionSummary=${JSON.stringify(result.rejectionSummary)}`);
}

for (const candidate of result.resizedCandidates ?? []) {
  if (
    candidate.noOrderWrite !== true ||
    typeof candidate.symbol !== "string" ||
    typeof candidate.resizedRiskPts !== "number" ||
    typeof candidate.resizedRewardPts !== "number" ||
    typeof candidate.resizedRiskNotional !== "number" ||
    candidate.resizedRiskNotional > candidate.maxRiskNotional ||
    !String(candidate.intentPath ?? "").includes("capital-risk-resized-paper-rerun/")
  ) {
    issues.push(`candidate=${JSON.stringify(candidate)}`);
  }
}

for (const rerun of result.reruns ?? []) {
  if (
    !["paper_resized_tail_passed", "paper_resized_tail_still_blocked"].includes(rerun.status) ||
    rerun.safetyLock?.writeBrokerOrders !== false ||
    rerun.safetyLock?.sentOrder !== false ||
    rerun.safetyLock?.noLiveOrderSent !== true ||
    rerun.noOrderWrite !== true ||
    typeof rerun.p05TotalPnlPts !== "number" ||
    typeof rerun.p05TotalPnlNotional !== "number"
  ) {
    issues.push(`rerun=${JSON.stringify(rerun)}`);
  }
}

for (const rejected of result.rejectionSummary?.rejectedCandidates ?? []) {
  if (
    rejected.decision !== "reject_for_promotion" ||
    rejected.noOrderWrite !== true ||
    !Array.isArray(rejected.rejectionReasons) ||
    rejected.rejectionReasons.length === 0 ||
    !rejected.rejectionReasons.some((reason) => String(reason).includes("p05")) ||
    rejected.nextAction !== "do_not_promote_wait_for_new_signal_or_refresh_tail_risk_repair"
  ) {
    issues.push(`rejected=${JSON.stringify(rejected)}`);
  }
}

if (
  result.status === "paper_resized_rerun_completed_still_blocked" &&
  result.rejectionSummary?.status !== "all_candidates_rejected"
) {
  issues.push(`rejectionSummary.status=${result.rejectionSummary?.status ?? ""}`);
}

if (
  result.rejectionSummary?.rejectedCount !==
  (result.reruns ?? []).filter((rerun) => rerun.status !== "paper_resized_tail_passed").length
) {
  issues.push(`rejectionSummary.rejectedCount=${result.rejectionSummary?.rejectedCount ?? ""}`);
}

if (result.resizedCandidateCount > 0 && result.reruns.length !== result.resizedCandidateCount) {
  issues.push(
    `rerunCount=${result.reruns.length};resizedCandidateCount=${result.resizedCandidateCount}`,
  );
}

if (
  result.status === "paper_resized_candidate_tail_passed_requires_promotion_rerun" &&
  result.passCount <= 0
) {
  issues.push("passCount=0");
}

if (issues.length > 0) {
  process.stderr.write(`CAPITAL_RISK_RESIZED_PAPER_RERUN_CHECK=FAIL ${issues.join("; ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `CAPITAL_RISK_RESIZED_PAPER_RERUN_CHECK=OK status=${result.status} candidates=${result.resizedCandidateCount} pass=${result.passCount} noLiveOrderSent=${result.safetyLock.noLiveOrderSent}\n`,
  );
}
