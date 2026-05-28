#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-trade-auto-cycle-latest.json",
);
const ALLOWED_STATUSES = new Set([
  "blocked_quote_not_fresh",
  "blocked_operator_inputs_required",
  "blocked_paper_strategy_not_promoted",
  "blocked_live_promotion_required",
]);
const REQUIRED_STEP_IDS = [
  "strategy_engine",
  "current_paper_intents_to_platform_gate",
  "strategy_fill_tail_risk",
  "paper_evaluator",
  "paper_auto_review",
  "fresh_paper_candidate_collector",
  "fresh_candidate_same_case_rerun",
  "opposite_exposure_paper_rerun",
];

function stepById(report, id) {
  return report.steps?.find((step) => step?.id === id);
}

const issues = [];
let report;
try {
  report = JSON.parse(await fs.readFile(REPORT_PATH, "utf8"));
} catch (error) {
  issues.push(`report read failed: ${error instanceof Error ? error.message : String(error)}`);
}

if (report) {
  if (report.schema !== "openclaw.capital.trade-auto-cycle.v1") {
    issues.push("schema mismatch");
  }
  if (!ALLOWED_STATUSES.has(report.status)) {
    issues.push(`status=${report.status}`);
  }
  if (report.mode !== "single_command_paper_strategy_cycle") {
    issues.push("mode mismatch");
  }
  for (const stepId of REQUIRED_STEP_IDS) {
    if (!stepById(report, stepId)) {
      issues.push(`step missing: ${stepId}`);
    }
  }
  if (report.safety?.paperOnly !== true) {
    issues.push("paperOnly must stay true");
  }
  if (
    report.safety?.liveTradingEnabled !== false ||
    report.safety?.writeBrokerOrders !== false ||
    report.safety?.brokerWriteAttempted !== false ||
    report.safety?.sentOrder !== false ||
    report.safety?.noLiveOrderSent !== true
  ) {
    issues.push("safety lock mismatch");
  }
  if (
    report.safety?.codexBrokerWriteAllowed !== false ||
    report.safety?.claudeBrokerWriteAllowed !== false ||
    report.safety?.openclawBrokerWriteAllowed !== false ||
    report.safety?.telegramBrokerWriteAllowed !== false
  ) {
    issues.push("agent broker write boundary mismatch");
  }
  if (report.decision?.canTradeInsideOpenClaw !== false) {
    issues.push("OpenClaw must not be marked as direct live executor");
  }
  if (report.decision?.noLiveOrderSent !== true || report.summary?.noLiveOrderSent !== true) {
    issues.push("noLiveOrderSent summary mismatch");
  }
  if (typeof report.summary?.operatorCanExecute !== "boolean") {
    issues.push("operatorCanExecute must be boolean");
  }
  if (!report.summary?.sealedOrderIntentSha256) {
    issues.push("sealedOrderIntentSha256 missing");
  }
  if (!report.paths?.reportPath || !report.paths?.panelPath) {
    issues.push("paths missing");
  }
  if (!report.nextSafeTask) {
    issues.push("nextSafeTask missing");
  }
  if (report.promotionBlockerDiagnostics?.noLiveOrderSent !== true) {
    issues.push("promotionBlockerDiagnostics noLiveOrderSent mismatch");
  }
  if (!report.promotionBlockerDiagnostics?.machineLine?.includes("promotionBlockers=")) {
    issues.push("promotionBlockerDiagnostics machineLine missing");
  }
  if (!report.summary?.adapterAckBlockerStatus) {
    issues.push("adapterAckBlockerStatus missing");
  }
  if (typeof report.summary?.adapterAckHashOk !== "boolean") {
    issues.push("adapterAckHashOk must be boolean");
  }
  if (
    !String(report.summary?.adapterAckBlockerMachineLine ?? "").includes("adapterAckBlocker=") ||
    !String(report.summary?.adapterAckBlockerMachineLine ?? "").includes("hashOk=")
  ) {
    issues.push("adapterAckBlockerMachineLine missing");
  }
  if (!report.summary?.verifiedPositionBlockerStatus) {
    issues.push("verifiedPositionBlockerStatus missing");
  }
  if (
    !String(report.summary?.verifiedPositionBlockerMachineLine ?? "").includes(
      "verifiedPositionBlocker=",
    ) ||
    !String(report.summary?.verifiedPositionBlockerMachineLine ?? "").includes("freshness=")
  ) {
    issues.push("verifiedPositionBlockerMachineLine missing");
  }
  if (!report.summary?.freshPaperCandidateCollectorStatus) {
    issues.push("freshPaperCandidateCollectorStatus missing");
  }
  if (!Number.isFinite(Number(report.summary?.freshPaperCandidateCount))) {
    issues.push("freshPaperCandidateCount must be numeric");
  }
  if (!report.summary?.failedReplayQuoteDigestGateStatus) {
    issues.push("failedReplayQuoteDigestGateStatus missing");
  }
  if (!Array.isArray(report.summary?.failedReplayQuoteDigestActiveSymbols)) {
    issues.push("failedReplayQuoteDigestActiveSymbols must be array");
  }
  if (!Array.isArray(report.summary?.failedReplayQuoteDigestUnlockedSymbols)) {
    issues.push("failedReplayQuoteDigestUnlockedSymbols must be array");
  }
  if (
    !String(report.summary?.failedReplayQuoteDigestMachineLine ?? "").includes(
      "failedReplayQuoteDigestGate=",
    )
  ) {
    issues.push("failedReplayQuoteDigestMachineLine missing");
  }
  if (!report.summary?.freshCandidateSameCaseRerunStatus) {
    issues.push("freshCandidateSameCaseRerunStatus missing");
  }
  if (!Number.isFinite(Number(report.summary?.freshCandidateSameCaseRerunPassCount))) {
    issues.push("freshCandidateSameCaseRerunPassCount must be numeric");
  }
  if (!report.summary?.oppositeExposurePaperRerunStatus) {
    issues.push("oppositeExposurePaperRerunStatus missing");
  }
  if (!Number.isFinite(Number(report.summary?.oppositeExposurePaperRerunPassCount))) {
    issues.push("oppositeExposurePaperRerunPassCount must be numeric");
  }
  const freshCandidateStep = stepById(report, "fresh_paper_candidate_collector");
  if (freshCandidateStep?.noLiveOrderSent !== true) {
    issues.push("fresh_paper_candidate_collector noLiveOrderSent mismatch");
  }
  if (!freshCandidateStep?.failedReplayQuoteDigestGateStatus) {
    issues.push("fresh_paper_candidate_collector failedReplayQuoteDigestGateStatus missing");
  }
  if (!Array.isArray(freshCandidateStep?.failedReplayQuoteDigestActiveSymbols)) {
    issues.push("fresh_paper_candidate_collector active symbols must be array");
  }
  if (!Array.isArray(freshCandidateStep?.failedReplayQuoteDigestUnlockedSymbols)) {
    issues.push("fresh_paper_candidate_collector unlocked symbols must be array");
  }
  const freshSameCaseStep = stepById(report, "fresh_candidate_same_case_rerun");
  if (freshSameCaseStep?.noLiveOrderSent !== true) {
    issues.push("fresh_candidate_same_case_rerun noLiveOrderSent mismatch");
  }
  const oppositeExposureStep = stepById(report, "opposite_exposure_paper_rerun");
  if (oppositeExposureStep?.noLiveOrderSent !== true) {
    issues.push("opposite_exposure_paper_rerun noLiveOrderSent mismatch");
  }
  const promotionGroups = Array.isArray(report.promotionBlockerDiagnostics?.groups)
    ? report.promotionBlockerDiagnostics.groups
    : [];
  for (const groupId of [
    "strategy_fill_gate",
    "quote_freshness",
    "adapter_ack",
    "verified_position_snapshot",
  ]) {
    if (!promotionGroups.some((group) => group?.id === groupId && group?.nextAction)) {
      issues.push(`promotionBlocker group missing: ${groupId}`);
    }
  }
}

if (issues.length > 0) {
  process.stderr.write(`CAPITAL_TRADE_AUTO_CYCLE_CHECK=FAIL ${issues.join("; ")}\n`);
  process.exit(1);
}

process.stdout.write(
  `CAPITAL_TRADE_AUTO_CYCLE_CHECK=OK status=${report.status} decision=${report.decision.status} quote=${report.summary.quoteFreshness} promotion=${report.summary.promotionBlockerStatus} strategyFillGate=${report.summary.strategyFillGate} operatorCanExecute=${report.summary.operatorCanExecute} noLiveOrderSent=${report.summary.noLiveOrderSent}\n`,
);
