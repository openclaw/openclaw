#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-direct-strategy-platform-gate-latest.json",
);
const ALLOWED_STATUSES = new Set([
  "blocked_quote_not_fresh",
  "blocked_operator_inputs_required",
  "blocked_paper_strategy_not_promoted",
  "blocked_live_promotion_required",
]);

function hasBlocker(report, blocker) {
  return Array.isArray(report.blockers) && report.blockers.includes(blocker);
}

function targetById(report, id) {
  return report.strategyPlatform?.targetRegistry?.activeUniverse?.find(
    (target) => target?.id === id,
  );
}

const issues = [];
let report;
try {
  report = JSON.parse(await fs.readFile(REPORT_PATH, "utf8"));
} catch (error) {
  issues.push(`report read failed: ${error instanceof Error ? error.message : String(error)}`);
}

if (report) {
  if (report.schema !== "openclaw.capital.direct-strategy-platform-gate.v1") {
    issues.push("schema mismatch");
  }
  if (!ALLOWED_STATUSES.has(report.status)) {
    issues.push(`status=${report.status}`);
  }
  if (report.strategyPlatform?.requestedTrade?.instrument !== "A50 202605") {
    issues.push("current direct A50 202605 trade missing");
  }
  if (report.strategyPlatform?.requestedTrade?.holdingMode !== "day_trade") {
    issues.push("requested trade must be day_trade");
  }
  if (report.execution?.liveWriteAllowed !== false) {
    issues.push("liveWriteAllowed must stay false");
  }
  if (report.execution?.sentOrder !== false || report.safety?.sentOrder !== false) {
    issues.push("sentOrder must stay false");
  }
  if (report.execution?.noLiveOrderSent !== true || report.safety?.noLiveOrderSent !== true) {
    issues.push("noLiveOrderSent must stay true");
  }
  if (report.safety?.writeBrokerOrders !== false) {
    issues.push("writeBrokerOrders must stay false");
  }
  if (report.safety?.paperOnly !== true) {
    issues.push("paperOnly must stay true");
  }
  if (
    !["a50_fresh", "multi_target_fresh", "blocked"].includes(report.quote?.overallFreshness ?? "")
  ) {
    issues.push(`overallFreshness invalid: ${report.quote?.overallFreshness}`);
  }
  if (
    report.quote?.overallFreshness === "multi_target_fresh" &&
    report.quote?.multiTarget?.freshPaperTargetCount <= 0
  ) {
    issues.push("multi_target_fresh requires fresh paper targets");
  }
  if (
    report.strategy?.currentPaperIntents?.status === "current_paper_intents_written" &&
    report.quote?.multiTarget?.freshPaperTargetCount > 0 &&
    report.quote?.strategyQuoteReady !== true
  ) {
    issues.push("current fresh paper intents must mark platform strategy quote ready");
  }
  if (
    report.status === "blocked_quote_not_fresh" &&
    report.quote?.overallFreshness === "multi_target_fresh"
  ) {
    issues.push("multi-target fresh platform must not be blocked only by A50 quote freshness");
  }
  if (report.quote?.multiTarget?.noLiveOrderSent !== true) {
    issues.push("multi-target quote summary must preserve noLiveOrderSent");
  }
  if (report.safety?.codexBrokerWriteAllowed !== false) {
    issues.push("Codex broker write must stay false");
  }
  if (report.safety?.openclawBrokerWriteAllowed !== false) {
    issues.push("OpenClaw broker write must stay false");
  }
  if (!report.execution?.sealedOrderIntentSha256) {
    issues.push("sealed order intent hash missing");
  }
  if (typeof report.execution?.operatorCanExecute !== "boolean") {
    issues.push("operatorCanExecute must be boolean");
  }
  if (
    !["blocked_do_not_send", "operator_adapter_may_execute_after_own_final_confirmation"].includes(
      report.execution?.dispatchPolicy ?? "",
    )
  ) {
    issues.push(`dispatchPolicy invalid: ${report.execution?.dispatchPolicy}`);
  }
  const liveCompletion = report.liveCompletion;
  const liveCompletionStages = Array.isArray(liveCompletion?.stages) ? liveCompletion.stages : [];
  const liveCompletionStageIds = new Set(liveCompletionStages.map((stage) => stage?.id));
  for (const stageId of [
    "quote:strategy-ready",
    "position:verified-fresh",
    "strategy:paper-promoted",
    "adapter:ack-hash-match",
    "adapter:canary-no-order",
    "adapter:rollback-fresh",
    "direct:pretrade-clear",
    "operator-packet:execution-ready",
  ]) {
    if (!liveCompletionStageIds.has(stageId)) {
      issues.push(`live completion stage missing: ${stageId}`);
    }
  }
  if (liveCompletion?.noLiveOrderSent !== true || liveCompletion?.sentOrder !== false) {
    issues.push("live completion safety mismatch");
  }
  if (liveCompletion?.writeBrokerOrders !== false) {
    issues.push("live completion writeBrokerOrders must stay false");
  }
  if (liveCompletion?.operatorCanExecute !== report.execution?.operatorCanExecute) {
    issues.push("live completion operatorCanExecute mismatch");
  }
  if (liveCompletion?.stageCount !== liveCompletionStages.length) {
    issues.push("live completion stage count mismatch");
  }
  if (
    liveCompletion?.status === "blocked" &&
    !hasBlocker(report, "live_completion:operator-packet:execution-ready")
  ) {
    issues.push("blocked live completion must surface operator packet blocker");
  }
  if (!report.externalBrokerAdapter?.ack?.path) {
    issues.push("external broker adapter ack path missing");
  }
  if (
    report.positionDecision?.usable !== true &&
    !hasBlocker(report, "position:verified_snapshot_missing")
  ) {
    issues.push("verified position blocker missing");
  }
  if (
    report.externalBrokerAdapter?.ack?.usable !== true &&
    !hasBlocker(report, "adapter:ack_missing")
  ) {
    issues.push("adapter ack blocker missing");
  }
  if (report.strategy?.paperFill?.safetyLock?.writeBrokerOrders !== false) {
    issues.push("paper fill write safety mismatch");
  }
  if (report.strategy?.paperOutcomeLedger?.safetyLock?.writeBrokerOrders !== false) {
    issues.push("paper outcome ledger write safety mismatch");
  }
  if (report.strategy?.paperOutcomeLedger?.safetyLock?.simulatedOnly !== true) {
    issues.push("paper outcome ledger must be simulated-only");
  }
  if (
    report.strategy?.paperOutcomeLedger?.status !== "ok" &&
    !hasBlocker(report, `paper_outcome_ledger:${report.strategy?.paperOutcomeLedger?.status}`)
  ) {
    issues.push("paper outcome ledger blocker missing");
  }
  if (report.strategy?.strategyFill?.safetyLock?.writeBrokerOrders !== false) {
    issues.push("strategy fill write safety mismatch");
  }
  if (report.strategy?.strategyTailRiskRepair?.safetyLock?.writeBrokerOrders !== false) {
    issues.push("strategy tail-risk repair write safety mismatch");
  }
  if (
    report.strategy?.strategyTailRiskRepair?.status !== "tail_risk_passed" &&
    !hasBlocker(report, `tail_risk_repair:${report.strategy?.strategyTailRiskRepair?.status}`)
  ) {
    issues.push("strategy tail-risk repair blocker missing");
  }
  if (
    report.strategy?.strategyTailRiskRepair?.machineLine &&
    !report.strategy.strategyTailRiskRepair.machineLine.includes("noOrderWrite=true")
  ) {
    issues.push("strategy tail-risk repair machine line missing safety marker");
  }
  if (report.strategy?.strategyTailRiskRepair?.repairCandidatePlan?.noOrderWrite !== true) {
    issues.push("strategy tail-risk repair candidate plan safety mismatch");
  }
  const tailRiskRepairBuckets = Array.isArray(
    report.strategy?.strategyTailRiskRepair?.repairCandidatePlan?.buckets,
  )
    ? report.strategy.strategyTailRiskRepair.repairCandidatePlan.buckets
    : [];
  if (tailRiskRepairBuckets.length < 6) {
    issues.push("strategy tail-risk repair candidate buckets missing");
  }
  if (
    !["current_paper_intents", "current_paper_blocked", "historical_snapshot", ""].includes(
      report.strategy?.strategyFill?.source?.simulationMode ?? "",
    )
  ) {
    issues.push(
      `strategy fill simulation mode invalid: ${report.strategy?.strategyFill?.source?.simulationMode}`,
    );
  }
  const strategyFillPromotionGate = report.strategy?.strategyFill?.promotionGate;
  if (!strategyFillPromotionGate || typeof strategyFillPromotionGate !== "object") {
    issues.push("strategy fill promotion gate missing");
  } else {
    const allowedGateStatuses = new Set(["blocked", "ready_for_paper_promotion"]);
    const blockedReasons = Array.isArray(strategyFillPromotionGate.blockedReasons)
      ? strategyFillPromotionGate.blockedReasons
      : [];
    if (!allowedGateStatuses.has(strategyFillPromotionGate.status)) {
      issues.push(`strategy fill promotion gate status=${strategyFillPromotionGate.status}`);
    }
    if (
      typeof strategyFillPromotionGate.machineLine !== "string" ||
      !strategyFillPromotionGate.machineLine.includes("strategyFillPromotionGate=") ||
      !strategyFillPromotionGate.machineLine.includes("noOrderWrite=true")
    ) {
      issues.push("strategy fill promotion gate machine line missing safety markers");
    }
    if (
      strategyFillPromotionGate.writeBrokerOrders !== false ||
      strategyFillPromotionGate.liveTradingEnabled !== false ||
      strategyFillPromotionGate.noLiveOrderSent !== true
    ) {
      issues.push("strategy fill promotion gate safety mismatch");
    }
    if (
      report.strategy?.strategyFill?.recommendation !== "promote" &&
      blockedReasons.length === 0
    ) {
      issues.push("strategy fill hold must include promotion gate blockers");
    }
    if (
      strategyFillPromotionGate.paperPromotionEligible === true &&
      report.strategy?.strategyFill?.recommendation !== "promote"
    ) {
      issues.push("paperPromotionEligible cannot be true unless strategy fill promotes");
    }
    for (const reason of blockedReasons) {
      if (!hasBlocker(report, `strategy_fill_gate:${reason}`)) {
        issues.push(`strategy fill gate blocker not surfaced: ${reason}`);
      }
    }
  }
  if (report.strategy?.evaluator?.safetyLock?.writeBrokerOrders !== false) {
    issues.push("evaluator write safety mismatch");
  }
  if (
    report.strategy?.currentPaperIntents?.status !== "missing" &&
    report.strategy?.currentPaperIntents?.safetyLock?.writeBrokerOrders !== false
  ) {
    issues.push("current paper intents write safety mismatch");
  }
  if (report.strategyPlatform?.targetRegistry?.scope !== "all_registered_capital_futures_routes") {
    issues.push("target registry scope mismatch");
  }
  if ((report.strategyPlatform?.targetRegistry?.coverage?.routeCount ?? 0) <= 1) {
    issues.push("target registry must cover more than one route");
  }
  if ((report.strategyPlatform?.targetRegistry?.summary?.activeUniverseCount ?? 0) < 5) {
    issues.push("active target universe too small");
  }
  if (
    (report.strategyPlatform?.targetRegistry?.summary?.brokerDeskDynamicTargetCount ?? 0) > 0 &&
    (report.strategyPlatform?.targetRegistry?.summary?.readyPaperTargetCount ?? 0) <= 0
  ) {
    issues.push("BrokerDesk fresh dynamic targets did not promote to paper-ready routes");
  }
  if (!targetById(report, "txf-current-month")) {
    issues.push("TXF target missing");
  }
  if (!targetById(report, "a50-direct-request")) {
    issues.push("A50 direct target missing");
  }
  if (
    report.strategyPlatform?.targetRegistry?.activeUniverse?.some(
      (target) => target?.writeBrokerOrders !== false || target?.liveTradingEnabled !== false,
    )
  ) {
    issues.push("target registry contains live/write-enabled target");
  }
  if (
    report.strategyPlatform?.targetRegistry?.activeUniverse?.some(
      (target) =>
        target?.wallClockFresh !== true &&
        ["quote_fresh_but_strategy_route_blocked", "core_quote_fresh_route_blocked"].includes(
          target?.readiness,
        ),
    )
  ) {
    issues.push("target registry contains wall-clock stale fresh readiness");
  }
}

if (issues.length > 0) {
  process.stderr.write(`CAPITAL_DIRECT_STRATEGY_PLATFORM_CHECK=FAIL issues=${issues.join(";")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `CAPITAL_DIRECT_STRATEGY_PLATFORM_CHECK=OK status=${report.status} targets=${report.strategyPlatform.targetRegistry.summary.activeUniverseCount}/${report.strategyPlatform.targetRegistry.coverage.routeCount} sha256=${report.execution.sealedOrderIntentSha256} position=${report.execution.positionDecision.status} ack=${report.externalBrokerAdapter.ack.status} quote=${report.quote.overallFreshness} strategyFillGate=${report.strategy.strategyFill.promotionGate.status} noLiveOrderSent=${report.safety.noLiveOrderSent}\n`,
  );
}
