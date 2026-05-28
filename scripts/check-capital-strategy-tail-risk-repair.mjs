#!/usr/bin/env node
// check-capital-strategy-tail-risk-repair.mjs - gate for paper-only tail-risk repair plans.

import { openclawPnpmCommand } from "./lib/openclaw-command-surface.mjs";
import { runCapitalStrategyTailRiskRepair } from "./openclaw-capital-strategy-tail-risk-repair.mjs";

const repoRoot = process.cwd();
const result = await runCapitalStrategyTailRiskRepair({ repoRoot });
const issues = [];

const cmd = (scriptName) => openclawPnpmCommand(repoRoot, scriptName);

function normalizedSymbol(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

if (result.schema !== "openclaw.capital.strategy-tail-risk-repair-plan.v1") {
  issues.push(`schema=${result.schema}`);
}

const allowedStatuses = new Set([
  "tail_risk_passed",
  "blocked_requires_same_case_rerun",
  "blocked_no_effective_repair_ready",
]);
if (!allowedStatuses.has(result.status)) {
  issues.push(`status=${result.status}`);
}

if (
  result.safetyLock?.liveTradingEnabled !== false ||
  result.safetyLock?.writeBrokerOrders !== false ||
  result.safetyLock?.brokerWriteAttempted !== false ||
  result.safetyLock?.sentOrder !== false ||
  result.safetyLock?.noLiveOrderSent !== true
) {
  issues.push(`safety=${JSON.stringify(result.safetyLock)}`);
}

if (!Array.isArray(result.repairActions) || result.repairActions.length < 4) {
  issues.push("repairActions missing");
}

if (result.repairCandidatePlan?.noOrderWrite !== true) {
  issues.push(`repairCandidatePlan.noOrderWrite=${result.repairCandidatePlan?.noOrderWrite}`);
}

const nextPaperCandidateBatch = result.repairCandidatePlan?.nextPaperCandidateBatch ?? {};
const sameCaseRerunEvidence = nextPaperCandidateBatch.sameCaseRerunEvidence ?? {};
const candidateQualityEvidence = nextPaperCandidateBatch.candidateQualityEvidence ?? {};
const promotionBlockerDiagnostic = result.promotionBlockerDiagnostic ?? {};
const freshCandidateRefreshPlan = result.repairCandidatePlan?.freshCandidateRefreshPlan ?? {};
const riskNotionalReviewPlan = result.repairCandidatePlan?.riskNotionalReviewPlan ?? {};
if (
  nextPaperCandidateBatch.schema !==
  "openclaw.capital.strategy-tail-risk-next-paper-candidate-batch.v1"
) {
  issues.push(`nextPaperCandidateBatch.schema=${nextPaperCandidateBatch.schema ?? ""}`);
}

if (
  !["ready_to_refresh_and_rerun", "blocked_no_candidate_batch"].includes(
    nextPaperCandidateBatch.status,
  )
) {
  issues.push(`nextPaperCandidateBatch.status=${nextPaperCandidateBatch.status ?? ""}`);
}

if (
  nextPaperCandidateBatch.safetyLock?.writeBrokerOrders !== false ||
  nextPaperCandidateBatch.safetyLock?.sentOrder !== false ||
  nextPaperCandidateBatch.safetyLock?.noLiveOrderSent !== true ||
  nextPaperCandidateBatch.noOrderWrite !== true
) {
  issues.push(`nextPaperCandidateBatch.safety=${JSON.stringify(nextPaperCandidateBatch)}`);
}

if (
  typeof nextPaperCandidateBatch.followUpCommand !== "string" ||
  nextPaperCandidateBatch.followUpCommand !== cmd("capital:strategy:fill-simulation:check")
) {
  issues.push(`nextPaperCandidateBatch.followUp=${nextPaperCandidateBatch.followUpCommand ?? ""}`);
}

if (
  !Array.isArray(nextPaperCandidateBatch.excludedFailedReplaySymbols) ||
  typeof nextPaperCandidateBatch.skippedFailedReplayCandidateCount !== "number" ||
  typeof nextPaperCandidateBatch.availableAfterExclusionCount !== "number" ||
  !String(nextPaperCandidateBatch.machineLine ?? "").includes("excludedFailedReplay=") ||
  !String(nextPaperCandidateBatch.machineLine ?? "").includes("skippedFailedReplay=")
) {
  issues.push(
    `nextPaperCandidateBatch.failedReplayExclusion=${JSON.stringify(nextPaperCandidateBatch)}`,
  );
}

const replayedBlockedSymbols = new Set(
  (Array.isArray(sameCaseRerunEvidence.replayOutcome?.selectedSymbols)
    ? sameCaseRerunEvidence.replayOutcome.selectedSymbols
    : []
  )
    .map((symbol) => String(symbol ?? "").toUpperCase())
    .filter(Boolean),
);
const nextBatchSymbols = new Set(
  (Array.isArray(nextPaperCandidateBatch.selectedSymbols)
    ? nextPaperCandidateBatch.selectedSymbols
    : []
  )
    .map((symbol) => String(symbol ?? "").toUpperCase())
    .filter(Boolean),
);
const excludedFailedReplaySymbols = new Set(
  (Array.isArray(nextPaperCandidateBatch.excludedFailedReplaySymbols)
    ? nextPaperCandidateBatch.excludedFailedReplaySymbols
    : []
  )
    .map((symbol) => String(symbol ?? "").toUpperCase())
    .filter(Boolean),
);
if (sameCaseRerunEvidence.replayOutcome?.status === "candidate_batch_replayed_still_blocked") {
  const repeatedSymbols = [...replayedBlockedSymbols].filter((symbol) =>
    nextBatchSymbols.has(symbol),
  );
  const missingExcludedSymbols = [...replayedBlockedSymbols].filter(
    (symbol) => !excludedFailedReplaySymbols.has(symbol),
  );
  if (repeatedSymbols.length > 0 || missingExcludedSymbols.length > 0) {
    issues.push(
      `nextPaperCandidateBatch.repeatsBlockedReplay repeated=${repeatedSymbols.join("|") || "none"} missingExcluded=${missingExcludedSymbols.join("|") || "none"}`,
    );
  }
}

if (
  sameCaseRerunEvidence.schema !== "openclaw.capital.strategy-tail-risk-same-case-rerun-evidence.v1"
) {
  issues.push(`sameCaseRerunEvidence.schema=${sameCaseRerunEvidence.schema ?? ""}`);
}

if (
  candidateQualityEvidence.schema !==
  "openclaw.capital.strategy-tail-risk-candidate-quality-evidence.v1"
) {
  issues.push(`candidateQualityEvidence.schema=${candidateQualityEvidence.schema ?? ""}`);
}

if (
  ![
    "blocked_no_candidates",
    "blocked_candidate_quality_incomplete",
    "candidate_quality_ready_for_rerun",
    "same_case_replay_still_blocked",
    "same_case_replay_tail_passed",
  ].includes(candidateQualityEvidence.status)
) {
  issues.push(`candidateQualityEvidence.status=${candidateQualityEvidence.status ?? ""}`);
}

if (
  candidateQualityEvidence.safetyLock?.writeBrokerOrders !== false ||
  candidateQualityEvidence.safetyLock?.sentOrder !== false ||
  candidateQualityEvidence.safetyLock?.noLiveOrderSent !== true ||
  candidateQualityEvidence.noOrderWrite !== true
) {
  issues.push(`candidateQualityEvidence.safety=${JSON.stringify(candidateQualityEvidence)}`);
}

if (
  promotionBlockerDiagnostic.schema !==
  "openclaw.capital.strategy-tail-risk-promotion-blocker-diagnostic.v1"
) {
  issues.push(`promotionBlockerDiagnostic.schema=${promotionBlockerDiagnostic.schema ?? ""}`);
}

if (
  freshCandidateRefreshPlan.schema !==
  "openclaw.capital.strategy-tail-risk-fresh-candidate-refresh-plan.v1"
) {
  issues.push(`freshCandidateRefreshPlan.schema=${freshCandidateRefreshPlan.schema ?? ""}`);
}

if (
  riskNotionalReviewPlan.schema !== "openclaw.capital.strategy-tail-risk-notional-review-plan.v1"
) {
  issues.push(`riskNotionalReviewPlan.schema=${riskNotionalReviewPlan.schema ?? ""}`);
}

if (
  ![
    "clear",
    "requires_paper_risk_resizing_review",
    "blocked_missing_risk_cap",
    "blocked_all_candidates_rejected",
  ].includes(riskNotionalReviewPlan.status)
) {
  issues.push(`riskNotionalReviewPlan.status=${riskNotionalReviewPlan.status ?? ""}`);
}

if (
  riskNotionalReviewPlan.noOrderWrite !== true ||
  riskNotionalReviewPlan.safetyLock?.writeBrokerOrders !== false ||
  riskNotionalReviewPlan.safetyLock?.sentOrder !== false ||
  riskNotionalReviewPlan.safetyLock?.noLiveOrderSent !== true
) {
  issues.push(`riskNotionalReviewPlan.safety=${JSON.stringify(riskNotionalReviewPlan)}`);
}

if (
  typeof riskNotionalReviewPlan.candidateCount !== "number" ||
  typeof riskNotionalReviewPlan.actionableCandidateCount !== "number" ||
  typeof riskNotionalReviewPlan.riskResizedRejectedCandidateCount !== "number" ||
  !Array.isArray(riskNotionalReviewPlan.candidates) ||
  !Array.isArray(riskNotionalReviewPlan.requiredEvidence) ||
  riskNotionalReviewPlan.requiredEvidence.length < 5 ||
  !Array.isArray(riskNotionalReviewPlan.forbiddenShortcut) ||
  riskNotionalReviewPlan.candidates.some((candidate) => candidate.canAutoApply !== false) ||
  !String(riskNotionalReviewPlan.machineLine ?? "").includes("riskNotionalReviewPlan=") ||
  !String(riskNotionalReviewPlan.machineLine ?? "").includes("riskResizedRejected=") ||
  !String(riskNotionalReviewPlan.machineLine ?? "").includes("noOrderWrite=true")
) {
  issues.push(`riskNotionalReviewPlan.shape=${JSON.stringify(riskNotionalReviewPlan)}`);
}

if (result.riskResizedRejectionExclusion?.status === "active_rejected_candidates_excluded") {
  const rejectedSymbols = new Set(
    (result.riskResizedRejectionExclusion?.rejectedSymbols ?? []).map((symbol) =>
      normalizedSymbol(symbol),
    ),
  );
  const rejectedCandidates = (riskNotionalReviewPlan.candidates ?? []).filter((candidate) =>
    rejectedSymbols.has(normalizedSymbol(candidate.symbol)),
  );
  const allCandidatesRejected =
    rejectedCandidates.length > 0 &&
    rejectedCandidates.length === riskNotionalReviewPlan.candidates.length;
  if (
    riskNotionalReviewPlan.riskResizedRejectedCandidateCount !== rejectedCandidates.length ||
    rejectedCandidates.some(
      (candidate) =>
        candidate.riskResizedRejected !== true ||
        candidate.reviewAction !== "paper_only_rejected_by_risk_resized_same_case_rerun",
    ) ||
    (allCandidatesRejected &&
      (riskNotionalReviewPlan.actionableCandidateCount !== 0 ||
        result.nextCommand?.command !== cmd("capital:trade:current-paper-intents")))
  ) {
    issues.push(
      `riskResizedRejectionExclusion.notApplied=${JSON.stringify({
        riskResizedRejectedCandidateCount: riskNotionalReviewPlan.riskResizedRejectedCandidateCount,
        rejectedCandidateCount: rejectedCandidates.length,
        actionableCandidateCount: riskNotionalReviewPlan.actionableCandidateCount,
        nextCommand: result.nextCommand?.command,
      })}`,
    );
  }
}

if (
  ![
    "ready_to_rerun_fresh_candidates",
    "refresh_candidates_available",
    "blocked_waiting_new_quote_digest_or_risk_review",
    "missing_fresh_candidate_pool",
  ].includes(freshCandidateRefreshPlan.status)
) {
  issues.push(`freshCandidateRefreshPlan.status=${freshCandidateRefreshPlan.status ?? ""}`);
}

if (
  freshCandidateRefreshPlan.noOrderWrite !== true ||
  freshCandidateRefreshPlan.safetyLock?.writeBrokerOrders !== false ||
  freshCandidateRefreshPlan.safetyLock?.sentOrder !== false ||
  freshCandidateRefreshPlan.safetyLock?.noLiveOrderSent !== true
) {
  issues.push(`freshCandidateRefreshPlan.safety=${JSON.stringify(freshCandidateRefreshPlan)}`);
}

if (
  typeof freshCandidateRefreshPlan.candidateCount !== "number" ||
  typeof freshCandidateRefreshPlan.readyRerunCandidateCount !== "number" ||
  typeof freshCandidateRefreshPlan.refreshableCandidateCount !== "number" ||
  typeof freshCandidateRefreshPlan.failedReplayExcludedCount !== "number" ||
  typeof freshCandidateRefreshPlan.riskResizedRejectedCount !== "number" ||
  typeof freshCandidateRefreshPlan.riskReviewCandidateCount !== "number" ||
  !Array.isArray(freshCandidateRefreshPlan.selectedMarketGroups) ||
  !Array.isArray(freshCandidateRefreshPlan.subscriptionSymbols) ||
  !Array.isArray(freshCandidateRefreshPlan.candidates) ||
  !String(freshCandidateRefreshPlan.machineLine ?? "").includes("freshCandidateRefreshPlan=") ||
  !String(freshCandidateRefreshPlan.machineLine ?? "").includes("riskResizedRejected=") ||
  !String(freshCandidateRefreshPlan.machineLine ?? "").includes("noOrderWrite=true")
) {
  issues.push(`freshCandidateRefreshPlan.shape=${JSON.stringify(freshCandidateRefreshPlan)}`);
}

if (
  result.selectedSymbols?.includes("CD0000") &&
  !freshCandidateRefreshPlan.selectedMarketGroups.includes("fx")
) {
  issues.push(
    `freshCandidateRefreshPlan.selectedMarketGroups=${freshCandidateRefreshPlan.selectedMarketGroups.join("|")}`,
  );
}

if (
  !["blocked_current_tail_evidence", "ready_for_same_case_rerun"].includes(
    promotionBlockerDiagnostic.status,
  )
) {
  issues.push(`promotionBlockerDiagnostic.status=${promotionBlockerDiagnostic.status ?? ""}`);
}

if (
  promotionBlockerDiagnostic.operatorDecision !== "do_not_promote" ||
  promotionBlockerDiagnostic.noOrderWrite !== true ||
  promotionBlockerDiagnostic.safetyLock?.writeBrokerOrders !== false ||
  promotionBlockerDiagnostic.safetyLock?.sentOrder !== false ||
  promotionBlockerDiagnostic.safetyLock?.noLiveOrderSent !== true
) {
  issues.push(`promotionBlockerDiagnostic.safety=${JSON.stringify(promotionBlockerDiagnostic)}`);
}

if (
  !Array.isArray(promotionBlockerDiagnostic.blockingFactors) ||
  !Array.isArray(promotionBlockerDiagnostic.requiredEvidence) ||
  promotionBlockerDiagnostic.requiredEvidence.length < 5 ||
  !Array.isArray(promotionBlockerDiagnostic.forbiddenShortcut) ||
  typeof promotionBlockerDiagnostic.candidateGate?.positiveTailCandidateCount !== "number" ||
  typeof promotionBlockerDiagnostic.candidateGate?.evaluatedSubsetCount !== "number" ||
  typeof promotionBlockerDiagnostic.empiricalGate?.sampleCount !== "number" ||
  !String(promotionBlockerDiagnostic.machineLine ?? "").includes("tailRiskPromotionDiagnostic=") ||
  !String(promotionBlockerDiagnostic.machineLine ?? "").includes("freshRefresh=") ||
  !String(promotionBlockerDiagnostic.machineLine ?? "").includes("riskReview=") ||
  !String(promotionBlockerDiagnostic.machineLine ?? "").includes("noOrderWrite=true")
) {
  issues.push(`promotionBlockerDiagnostic.shape=${JSON.stringify(promotionBlockerDiagnostic)}`);
}

if (
  result.status !== "tail_risk_passed" &&
  promotionBlockerDiagnostic.status !== "blocked_current_tail_evidence"
) {
  issues.push(`promotionBlockerDiagnostic.blockedStatus=${promotionBlockerDiagnostic.status}`);
}

if (
  typeof candidateQualityEvidence.selectedCandidateCount !== "number" ||
  typeof candidateQualityEvidence.freshResolvedCount !== "number" ||
  typeof candidateQualityEvidence.knownPointValueCount !== "number" ||
  typeof candidateQualityEvidence.oppositeExposureCount !== "number" ||
  typeof candidateQualityEvidence.crossGroupProxyCount !== "number" ||
  !Array.isArray(candidateQualityEvidence.candidates) ||
  !String(candidateQualityEvidence.machineLine ?? "").includes("candidateQualityEvidence=") ||
  !String(candidateQualityEvidence.machineLine ?? "").includes("noOrderWrite=true")
) {
  issues.push(`candidateQualityEvidence.shape=${JSON.stringify(candidateQualityEvidence)}`);
}

if (!Array.isArray(sameCaseRerunEvidence.candidateContributionRanking)) {
  issues.push("sameCaseRerunEvidence.candidateContributionRanking missing");
}

if (
  ![
    "ready_for_same_case_rerun",
    "ready_for_next_same_case_rerun",
    "blocked_no_candidates",
    "rerun_completed_still_blocked",
    "rerun_completed_tail_passed_requires_promotion_rerun",
  ].includes(sameCaseRerunEvidence.status)
) {
  issues.push(`sameCaseRerunEvidence.status=${sameCaseRerunEvidence.status ?? ""}`);
}

if (
  sameCaseRerunEvidence.safetyLock?.writeBrokerOrders !== false ||
  sameCaseRerunEvidence.safetyLock?.sentOrder !== false ||
  sameCaseRerunEvidence.safetyLock?.noLiveOrderSent !== true ||
  sameCaseRerunEvidence.noOrderWrite !== true
) {
  issues.push(`sameCaseRerunEvidence.safety=${JSON.stringify(sameCaseRerunEvidence)}`);
}

if (
  ![
    cmd("capital:strategy:fill-simulation:check"),
    cmd("capital:trade:current-paper-intents"),
  ].includes(sameCaseRerunEvidence.followUpCommand)
) {
  issues.push(`sameCaseRerunEvidence.followUp=${sameCaseRerunEvidence.followUpCommand ?? ""}`);
}

if (sameCaseRerunEvidence.status === "rerun_completed_still_blocked") {
  if (
    sameCaseRerunEvidence.replayOutcome?.schema !==
      "openclaw.capital.strategy-tail-risk-rerun-outcome.v1" ||
    sameCaseRerunEvidence.replayOutcome?.status !== "candidate_batch_replayed_still_blocked" ||
    sameCaseRerunEvidence.replayOutcome?.replayTailPass !== false ||
    sameCaseRerunEvidence.replayOutcome?.noOrderWrite !== true
  ) {
    issues.push(`sameCaseRerunEvidence.replayOutcome=${JSON.stringify(sameCaseRerunEvidence)}`);
  }
}

if (sameCaseRerunEvidence.status === "ready_for_next_same_case_rerun") {
  if (
    sameCaseRerunEvidence.replayOutcome?.schema !==
      "openclaw.capital.strategy-tail-risk-rerun-outcome.v1" ||
    sameCaseRerunEvidence.replayOutcome?.status !== "candidate_batch_replayed_still_blocked" ||
    sameCaseRerunEvidence.replayOutcome?.failedReplayHistory?.schema !==
      "openclaw.capital.strategy-tail-risk-failed-replay-history.v1" ||
    !Array.isArray(sameCaseRerunEvidence.replayOutcome?.failedReplayHistory?.excludedSymbols) ||
    !String(sameCaseRerunEvidence.machineLine ?? "").includes("failedReplayExcluded=true")
  ) {
    issues.push(`sameCaseRerunEvidence.nextReplay=${JSON.stringify(sameCaseRerunEvidence)}`);
  }
}

const repairBuckets = Array.isArray(result.repairCandidatePlan?.buckets)
  ? result.repairCandidatePlan.buckets
  : [];
if (repairBuckets.length < 6) {
  issues.push("repairCandidatePlan.buckets missing");
}

const requiredBucketIds = new Set([
  "fresh_resolved_low_correlation_or_opposite_exposure",
  "contract_point_value_currency_backfill",
  "risk_notional_cap_review",
  "selected_signal_confidence_recheck",
  "empirical_stop_hit_calibration",
  "same_case_rerun",
]);
for (const bucketId of requiredBucketIds) {
  if (!repairBuckets.some((bucket) => bucket.id === bucketId)) {
    issues.push(`repairCandidatePlan.bucket.${bucketId}=missing`);
  }
}

if (
  result.status !== "tail_risk_passed" &&
  result.repairCandidatePlan?.status !== "needs_candidate_or_outcome_evidence" &&
  result.repairCandidatePlan?.status !== "candidate_or_calibration_ready_for_rerun"
) {
  issues.push(`repairCandidatePlan.status=${result.repairCandidatePlan?.status ?? ""}`);
}

if (
  typeof result.nextCommand?.command !== "string" ||
  !result.nextCommand.command.startsWith(`pnpm --dir ${repoRoot} capital:`)
) {
  issues.push(`nextCommand.command=${result.nextCommand?.command ?? ""}`);
}

if (
  typeof result.nextCommand?.validationCommand !== "string" ||
  !result.nextCommand.validationCommand.startsWith(`pnpm --dir ${repoRoot} capital:`)
) {
  issues.push(`nextCommand.validationCommand=${result.nextCommand?.validationCommand ?? ""}`);
}

if (result.nextCommand?.noOrderWrite !== true) {
  issues.push(`nextCommand.noOrderWrite=${result.nextCommand?.noOrderWrite}`);
}

const hasActionableRiskResize =
  riskNotionalReviewPlan.status === "requires_paper_risk_resizing_review" &&
  Number(riskNotionalReviewPlan.actionableCandidateCount ?? 0) > 0;

if (
  result.status === "blocked_no_effective_repair_ready" &&
  hasActionableRiskResize &&
  result.nextCommand?.command !== cmd("capital:strategy:risk-resized-paper-rerun:check")
) {
  issues.push(`blocked.riskResize.nextCommand=${result.nextCommand?.command ?? ""}`);
}

if (
  result.status === "blocked_no_effective_repair_ready" &&
  !hasActionableRiskResize &&
  result.nextCommand?.command !== cmd("capital:trade:current-paper-intents")
) {
  issues.push(`blocked.refresh.nextCommand=${result.nextCommand?.command ?? ""}`);
}

if (
  result.promotionBlockedReasons.includes("tail_risk_positive") &&
  result.status === "tail_risk_passed"
) {
  issues.push("tail_risk_positive cannot pass repair plan");
}

if (
  result.repairActions.some(
    (action) => action.id === "sizing_only_repair" && action.status !== "ineffective",
  )
) {
  issues.push("sizing-only repair must stay ineffective");
}

if (!String(result.machineLine ?? "").includes("noOrderWrite=true")) {
  issues.push("machineLine missing noOrderWrite marker");
}

if (!String(result.machineLine ?? "").includes("nextCommand=")) {
  issues.push("machineLine missing nextCommand marker");
}

if (!String(result.machineLine ?? "").includes("validationCommand=")) {
  issues.push("machineLine missing validationCommand marker");
}

if (!String(result.machineLine ?? "").includes("candidatePlan=")) {
  issues.push("machineLine missing candidatePlan marker");
}

if (!String(result.machineLine ?? "").includes("nextPaperCandidateBatch=")) {
  issues.push("machineLine missing nextPaperCandidateBatch marker");
}

if (!String(result.machineLine ?? "").includes("freshCandidateRefresh=")) {
  issues.push("machineLine missing freshCandidateRefresh marker");
}

if (!String(result.machineLine ?? "").includes("riskNotionalReview=")) {
  issues.push("machineLine missing riskNotionalReview marker");
}

if (!String(result.machineLine ?? "").includes("promotionDiagnostic=")) {
  issues.push("machineLine missing promotionDiagnostic marker");
}

if (
  !String(result.repairCandidatePlan?.nextPaperCandidateBatch?.machineLine ?? "").includes(
    "sameCaseRerunEvidence=",
  )
) {
  issues.push("nextPaperCandidateBatch machineLine missing sameCaseRerunEvidence marker");
}

if (
  !String(result.repairCandidatePlan?.nextPaperCandidateBatch?.machineLine ?? "").includes(
    "candidateQualityEvidence=",
  )
) {
  issues.push("nextPaperCandidateBatch machineLine missing candidateQualityEvidence marker");
}

if (!String(result.machineLine ?? "").includes("candidateBuckets=")) {
  issues.push("machineLine missing candidateBuckets marker");
}

if (issues.length > 0) {
  process.stderr.write(`CAPITAL_STRATEGY_TAIL_RISK_REPAIR_CHECK=FAIL issues=${issues.join(";")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `CAPITAL_STRATEGY_TAIL_RISK_REPAIR_CHECK=OK status=${result.status} p05=${result.currentP05Pts} selected=${result.selectedSymbols.join(",") || "none"} nextCommand="${result.nextCommand.command}" noLiveOrderSent=${result.safetyLock.noLiveOrderSent}\n`,
  );
}
