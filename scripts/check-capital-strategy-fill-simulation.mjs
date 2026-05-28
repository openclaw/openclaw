#!/usr/bin/env node
// check-capital-strategy-fill-simulation.mjs — gate check for strategy fill simulator.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runStrategyFillSimulation } from "./openclaw-capital-strategy-fill-simulator.mjs";

const result = await runStrategyFillSimulation({ repoRoot: process.cwd() });

if (!result.schema?.startsWith("openclaw.capital.strategy-fill-simulation")) {
  throw new Error(`Strategy fill simulator returned unexpected schema: ${result.schema}`);
}

if (result.status === "no_intents") {
  process.stdout.write("CAPITAL_STRATEGY_FILL_SIMULATION_CHECK=OK no_intents\n");
  process.exit(0);
}

if (!["ok", "historical_simulated", "current_paper_blocked"].includes(result.status)) {
  throw new Error(`Strategy fill simulator returned non-ok status: ${result.status}`);
}

const { stats, safetyLock } = result;
if (
  safetyLock?.sentOrder !== false ||
  safetyLock?.noLiveOrderSent !== true ||
  safetyLock?.writeBrokerOrders !== false ||
  safetyLock?.liveTradingEnabled !== false
) {
  throw new Error(`Strategy fill simulator safety lock malformed: ${JSON.stringify(safetyLock)}`);
}

if (
  typeof stats?.total_intents !== "number" ||
  typeof stats?.filled_count !== "number" ||
  typeof stats?.fill_rate !== "number" ||
  typeof stats?.win_rate !== "number" ||
  typeof stats?.evidence_fill_rate !== "number" ||
  typeof stats?.evidence_win_rate !== "number" ||
  typeof stats?.evidence_sample_count !== "number" ||
  typeof stats?.total_pnl_notional !== "number" ||
  typeof stats?.avg_pnl_notional !== "number" ||
  typeof stats?.expected_value_pts !== "number" ||
  typeof stats?.expected_value_notional !== "number" ||
  typeof stats?.max_risk_notional !== "number" ||
  !Array.isArray(stats?.currency_set) ||
  typeof stats?.normalized_legacy_alias_count !== "number" ||
  typeof stats?.blocked_legacy_alias_count !== "number" ||
  typeof stats?.historical_snapshot_count !== "number" ||
  typeof stats?.route_unresolved_count !== "number" ||
  typeof stats?.paper_exploration_only_count !== "number" ||
  typeof stats?.execution_ineligible_count !== "number" ||
  typeof stats?.promotion_blocked_intent_count !== "number" ||
  typeof stats?.source_intent_count !== "number" ||
  typeof stats?.risk_approved_intent_count !== "number" ||
  typeof stats?.risk_filtered_intent_count !== "number" ||
  typeof stats?.downside_filtered_intent_count !== "number" ||
  typeof stats?.source_historical_snapshot_count !== "number" ||
  typeof stats?.source_route_unresolved_count !== "number" ||
  typeof stats?.source_paper_exploration_only_count !== "number" ||
  typeof stats?.source_execution_ineligible_count !== "number" ||
  typeof stats?.source_promotion_blocked_intent_count !== "number" ||
  stats?.risk_filter?.model !== "current_paper_point_value_risk_overlay_v1" ||
  stats?.risk_filter?.downsideFilter?.model !== "current_paper_downside_subset_filter_v1" ||
  stats?.risk_filter?.repairCandidateReplay?.schema !==
    "openclaw.capital.strategy-tail-risk-repair-candidate-replay.v1" ||
  typeof stats?.risk_filter?.repairCandidateReplay?.status !== "string" ||
  !Array.isArray(stats?.risk_filter?.repairCandidateReplay?.selectedSymbols) ||
  typeof stats?.risk_filter?.repairCandidateReplay?.selectedCandidateCount !== "number" ||
  stats?.risk_filter?.repairCandidateReplay?.failedReplayHistory?.schema !==
    "openclaw.capital.strategy-tail-risk-failed-replay-history.v1" ||
  typeof stats?.risk_filter?.repairCandidateReplay?.failedReplayHistory?.basketCount !== "number" ||
  !Array.isArray(stats?.risk_filter?.repairCandidateReplay?.failedReplayHistory?.baskets) ||
  !Array.isArray(stats?.risk_filter?.repairCandidateReplay?.failedReplayHistory?.excludedSymbols) ||
  stats?.risk_filter?.repairCandidateReplay?.activeFailedReplayExclusion?.schema !==
    "openclaw.capital.strategy-tail-risk-active-failed-replay-exclusion.v1" ||
  !Array.isArray(
    stats?.risk_filter?.repairCandidateReplay?.activeFailedReplayExclusion?.excludedSymbols,
  ) ||
  typeof stats?.risk_filter?.repairCandidateReplay?.activeFailedReplayExclusion
    ?.matchedBasketCount !== "number" ||
  typeof stats?.risk_filter?.repairCandidateReplay?.activeFailedReplayExclusion
    ?.staleBasketCount !== "number" ||
  stats?.risk_filter?.repairCandidateReplay?.noOrderWrite !== true ||
  stats?.risk_filter?.repairCandidateReplay?.safetyLock?.writeBrokerOrders !== false ||
  stats?.risk_filter?.repairCandidateReplay?.safetyLock?.noLiveOrderSent !== true ||
  !String(stats?.risk_filter?.repairCandidateReplay?.machineLine ?? "").includes(
    "noOrderWrite=true",
  ) ||
  !String(stats?.risk_filter?.repairCandidateReplay?.machineLine ?? "").includes(
    "activeFailedReplayExclusion=",
  ) ||
  typeof stats?.risk_filter?.downsideFilter?.evaluatedSubsetCount !== "number" ||
  typeof stats?.risk_filter?.downsideFilter?.positiveTailCandidateCount !== "number" ||
  typeof stats?.risk_filter?.unknownPointValueFilteredCount !== "number" ||
  !Array.isArray(stats?.risk_filter?.rejectedIntentDiagnostics) ||
  !Array.isArray(stats?.risk_filter?.actionableRepairCandidates) ||
  !Array.isArray(stats?.risk_filter?.downsideFilter?.selectedSymbols)
) {
  throw new Error(`Strategy fill simulator stats malformed: ${JSON.stringify(stats)}`);
}

if (stats.total_intents <= 0) {
  throw new Error(
    `Strategy fill simulator needs non-empty paper or fallback strategy intents: ${JSON.stringify(result.source)}`,
  );
}

if (
  stats.source_intent_count < stats.total_intents ||
  stats.risk_approved_intent_count !== stats.total_intents ||
  stats.risk_filtered_intent_count !== Math.max(0, stats.source_intent_count - stats.total_intents)
) {
  throw new Error(
    `Strategy fill simulator risk overlay counts malformed: ${JSON.stringify({
      total_intents: stats.total_intents,
      source_intent_count: stats.source_intent_count,
      risk_approved_intent_count: stats.risk_approved_intent_count,
      risk_filtered_intent_count: stats.risk_filtered_intent_count,
      risk_filter: stats.risk_filter,
    })}`,
  );
}

const fallbackIsGeneratedCurrent =
  result.source?.sourceKind === "generated_current" ||
  String(result.source?.fallbackReason ?? "").includes("generated_current");

if (
  result.source?.fallbackUsed === true &&
  !fallbackIsGeneratedCurrent &&
  result.recommendation !== "hold"
) {
  throw new Error(
    `Fallback intents must not promote paper strategy: ${JSON.stringify(result.source)}`,
  );
}

if (result.status === "historical_simulated") {
  if (result.recommendation !== "hold") {
    throw new Error(`Historical snapshot simulation must hold: ${JSON.stringify(result)}`);
  }
  if (
    result.source?.simulationMode !== "historical_snapshot" ||
    safetyLock?.executionEligible !== false ||
    safetyLock?.promotionBlocked !== true ||
    safetyLock?.historicalSnapshot !== true
  ) {
    throw new Error(
      `Historical snapshot simulation safety lock malformed: ${JSON.stringify({ source: result.source, safetyLock })}`,
    );
  }
}

if (result.status === "current_paper_blocked") {
  if (result.recommendation !== "hold") {
    throw new Error(`Current paper blocked simulation must hold: ${JSON.stringify(result)}`);
  }
  if (
    result.source?.simulationMode !== "current_paper_blocked" ||
    safetyLock?.executionEligible !== false ||
    safetyLock?.promotionBlocked !== true ||
    safetyLock?.historicalSnapshot !== false ||
    !result.promotionGate?.blockedReasons?.includes("route_resolved_for_paper_execution")
  ) {
    throw new Error(
      `Current paper blocked safety lock malformed: ${JSON.stringify({ source: result.source, safetyLock, promotionGate: result.promotionGate })}`,
    );
  }
}

if (result.monteCarlo?.p05_total_pnl_pts <= 0 && result.recommendation !== "hold") {
  throw new Error(
    `Negative Monte Carlo p05 must not promote strategy: ${JSON.stringify(result.monteCarlo)}`,
  );
}

if (
  !result.tailRiskRepair ||
  result.tailRiskRepair.schema !== "openclaw.capital.strategy-tail-risk-repair.v1" ||
  result.empiricalTailEvidence?.schema !== "openclaw.capital.strategy-tail-empirical-evidence.v1" ||
  result.empiricalTailEvidence?.noLiveOrderSent !== true ||
  typeof result.empiricalTailEvidence?.status !== "string" ||
  typeof result.empiricalTailEvidence?.outcomeStats?.sampleCount !== "number" ||
  typeof result.empiricalTailEvidence?.requirements?.minOutcomeSamples !== "number" ||
  typeof result.tailRiskRepair.currentP05Pts !== "number" ||
  typeof result.tailRiskRepair.currentP05Notional !== "number" ||
  typeof result.tailRiskRepair.positiveTailCandidateCount !== "number" ||
  !Array.isArray(result.tailRiskRepair.selectedSymbols) ||
  !Array.isArray(result.tailRiskRepair.rejectedIntentDiagnostics) ||
  !Array.isArray(result.tailRiskRepair.actionableRepairCandidates) ||
  result.tailRiskRepair.repairCandidateReplay?.schema !==
    "openclaw.capital.strategy-tail-risk-repair-candidate-replay.v1" ||
  result.tailRiskRepair.repairCandidateReplay?.failedReplayHistory?.schema !==
    "openclaw.capital.strategy-tail-risk-failed-replay-history.v1" ||
  typeof result.tailRiskRepair.repairCandidateReplay?.failedReplayHistory?.basketCount !==
    "number" ||
  !Array.isArray(result.tailRiskRepair.repairCandidateReplay?.failedReplayHistory?.baskets) ||
  !Array.isArray(
    result.tailRiskRepair.repairCandidateReplay?.failedReplayHistory?.excludedSymbols,
  ) ||
  result.tailRiskRepair.repairCandidateReplay?.activeFailedReplayExclusion?.schema !==
    "openclaw.capital.strategy-tail-risk-active-failed-replay-exclusion.v1" ||
  !Array.isArray(
    result.tailRiskRepair.repairCandidateReplay?.activeFailedReplayExclusion?.excludedSymbols,
  ) ||
  result.tailRiskRepair.repairCandidateReplay?.noOrderWrite !== true ||
  result.tailRiskRepair.repairCandidateReplay?.safetyLock?.writeBrokerOrders !== false ||
  result.tailRiskRepair.repairCandidateReplay?.safetyLock?.noLiveOrderSent !== true ||
  result.tailRiskRepair.repairCandidatePlan?.schema !==
    "openclaw.capital.strategy-tail-risk-repair-candidate-plan.v1" ||
  !Array.isArray(result.tailRiskRepair.repairCandidatePlan?.selectedNeedsConfidence) ||
  !Array.isArray(
    result.tailRiskRepair.repairCandidatePlan?.downsideFilteredLowCorrelationCandidates,
  ) ||
  !Array.isArray(result.tailRiskRepair.repairCandidatePlan?.overMaxRiskCandidates) ||
  !Array.isArray(result.tailRiskRepair.repairCandidatePlan?.unknownPointValueCandidates) ||
  result.tailRiskRepair.repairCandidatePlan?.empiricalStopHitCalibration?.noLiveOrderSent !==
    true ||
  result.tailRiskRepair.repairCandidatePlan?.sameCaseRerun?.noLiveOrderSent !== true ||
  result.tailRiskRepair.repairCandidatePlan?.safetyLock?.writeBrokerOrders !== false ||
  result.tailRiskRepair.tailPassFeasibility?.model !== "current_paper_tail_pass_feasibility_v1" ||
  typeof result.tailRiskRepair.tailPassFeasibility?.fillRateAssumption !== "number" ||
  typeof result.tailRiskRepair.tailPassFeasibility?.p05RequiresLossProbabilityBelow !== "number" ||
  !Array.isArray(result.tailRiskRepair.tailPassFeasibility?.selectedSymbols) ||
  typeof result.tailRiskRepair.tailPassFeasibility?.infeasibleSelectedCount !== "number" ||
  result.tailRiskRepair.tailPassFeasibility?.noLiveOrderSent !== true ||
  result.tailRiskRepair.tailPassFeasibility?.empiricalTailEvidence?.noLiveOrderSent !== true ||
  result.tailRiskRepair.safetyLock?.noLiveOrderSent !== true ||
  result.tailRiskRepair.safetyLock?.writeBrokerOrders !== false
) {
  throw new Error(
    `Strategy tail-risk repair report malformed: ${JSON.stringify(result.tailRiskRepair)}`,
  );
}

if (result.promotionGate?.blockedReasons?.includes("tail_risk_positive")) {
  if (
    result.tailRiskRepair.status !== "blocked_no_positive_tail_candidate" ||
    result.tailRiskRepair.blocker !== "tail_risk_positive" ||
    !String(result.tailRiskRepair.machineLine ?? "").includes("noOrderWrite=true") ||
    !String(result.tailRiskRepair.machineLine ?? "").includes("repairReplay=") ||
    !String(result.tailRiskRepair.repairCandidatePlan?.machineLine ?? "").includes(
      "noOrderWrite=true",
    )
  ) {
    throw new Error(
      `Tail-risk blocker must produce repair evidence: ${JSON.stringify(result.tailRiskRepair)}`,
    );
  }
  if (
    result.source?.simulationMode === "current_paper_intents" &&
    result.tailRiskRepair.rejectedIntentDiagnostics.length <= 0
  ) {
    throw new Error(
      `Tail-risk blocker must include rejected intent diagnostics: ${JSON.stringify(result.tailRiskRepair)}`,
    );
  }
  if (
    result.source?.simulationMode === "current_paper_intents" &&
    result.tailRiskRepair.tailPassFeasibility.infeasibleSelectedCount <= 0
  ) {
    throw new Error(
      `Tail-risk blocker must include selected-intent feasibility evidence: ${JSON.stringify(result.tailRiskRepair.tailPassFeasibility)}`,
    );
  }
}

if (result.recommendation === "promote" && stats.risk_filter?.downsideFilter?.tailPass !== true) {
  throw new Error(
    `Promoted strategy must pass downside subset filter: ${JSON.stringify(stats.risk_filter?.downsideFilter)}`,
  );
}

if (result.recommendation === "promote" && stats.currency_set.includes("POINT")) {
  throw new Error(
    `Promoted strategy must not use unknown contract point value: ${JSON.stringify(stats.currency_set)}`,
  );
}

const repairReplay = stats.risk_filter?.repairCandidateReplay ?? {};
if (repairReplay.status === "candidate_batch_replayed_still_blocked") {
  const replayedSymbols = new Set(
    (Array.isArray(repairReplay.selectedSymbols) ? repairReplay.selectedSymbols : [])
      .map((symbol) => String(symbol ?? "").toUpperCase())
      .filter(Boolean),
  );
  const excludedSymbols = new Set(
    (Array.isArray(repairReplay.failedReplayHistory?.excludedSymbols)
      ? repairReplay.failedReplayHistory.excludedSymbols
      : []
    )
      .map((symbol) => String(symbol ?? "").toUpperCase())
      .filter(Boolean),
  );
  const missingReplaySymbols = [...replayedSymbols].filter(
    (symbol) => !excludedSymbols.has(symbol),
  );
  if (missingReplaySymbols.length > 0) {
    throw new Error(
      `Blocked tail repair replay must be recorded in failed history: ${missingReplaySymbols.join("|")}`,
    );
  }
}

if (stats.normalized_legacy_alias_count < 0) {
  throw new Error(
    `normalized_legacy_alias_count malformed: ${stats.normalized_legacy_alias_count}`,
  );
}

if (stats.normalized_legacy_alias_count !== 0) {
  throw new Error(
    `Legacy aliases must be blocked, not normalized: ${stats.normalized_legacy_alias_count}`,
  );
}

if (
  result.monteCarlo?.iterations !== 500 ||
  typeof result.monteCarlo?.p05_total_pnl_pts !== "number" ||
  typeof result.monteCarlo?.p50_total_pnl_pts !== "number" ||
  typeof result.monteCarlo?.p95_total_pnl_pts !== "number" ||
  typeof result.monteCarlo?.p05_total_pnl_notional !== "number" ||
  typeof result.monteCarlo?.p50_total_pnl_notional !== "number" ||
  typeof result.monteCarlo?.p95_total_pnl_notional !== "number" ||
  typeof result.monteCarlo?.positive_notional_rate !== "number" ||
  typeof result.monteCarlo?.positive_rate !== "number" ||
  typeof result.monteCarlo?.fill_rate !== "number" ||
  typeof result.monteCarlo?.win_rate !== "number" ||
  typeof result.monteCarlo?.fill_attempt_count !== "number"
) {
  throw new Error(
    `Strategy fill simulator Monte Carlo summary malformed: ${JSON.stringify(result.monteCarlo)}`,
  );
}

if (JSON.stringify(result).includes("TX00AM") || JSON.stringify(result).includes("TX06AM")) {
  throw new Error(
    "Strategy fill simulator report must not leak legacy active symbols TX00AM/TX06AM",
  );
}

const legacyTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capital-fill-legacy-"));
try {
  const legacyIntentPath = path.join(legacyTmpDir, "legacy-intents.jsonl");
  const legacyOutputPath = path.join(legacyTmpDir, "legacy-report.json");
  await fs.writeFile(
    legacyIntentPath,
    `${JSON.stringify({
      schema: "openclaw.capital.paper-intent.v2",
      intentId: "legacy-alias-guard",
      symbol: "TX00AM",
      strategy: "orb_long",
      riskPts: 10,
      rewardPts: 20,
      confidence: 0.6,
      paperOnly: true,
      executionEligible: false,
      historicalSnapshot: true,
      promotionBlocked: true,
      allowLiveTrading: false,
      writeBrokerOrders: false,
      promoteLiveAuto: false,
    })}\n`,
    "utf8",
  );
  const legacyResult = await runStrategyFillSimulation({
    repoRoot: process.cwd(),
    intentsPath: legacyIntentPath,
    fallbackIntentsPath: path.join(legacyTmpDir, "missing-fallback.jsonl"),
    outputPath: legacyOutputPath,
  });
  if (
    legacyResult.stats?.blocked_legacy_alias_count !== 1 ||
    legacyResult.stats?.total_intents !== 0 ||
    legacyResult.stats?.normalized_legacy_alias_count !== 0 ||
    legacyResult.recommendation !== "hold" ||
    JSON.stringify(legacyResult).includes("TX00AM")
  ) {
    throw new Error(`Legacy alias guard failed: ${JSON.stringify(legacyResult)}`);
  }
} finally {
  await fs.rm(legacyTmpDir, { recursive: true, force: true });
}

if (
  safetyLock?.paperOnly !== true ||
  safetyLock?.allowLiveTrading !== false ||
  safetyLock?.liveTradingEnabled !== false ||
  safetyLock?.writeBrokerOrders !== false ||
  safetyLock?.writeTradingEnabled !== false ||
  safetyLock?.brokerOrderPathEnabled !== false ||
  safetyLock?.promoteLiveAutomatically !== false ||
  safetyLock?.promoteLiveAuto !== false
) {
  throw new Error(
    `Strategy fill simulator safety lock is not paper-only: ${JSON.stringify(safetyLock)}`,
  );
}

process.stdout.write(
  [
    "CAPITAL_STRATEGY_FILL_SIMULATION_CHECK=OK",
    `recommendation=${result.recommendation}`,
    `total=${stats.total_intents}`,
    `filled=${stats.filled_count}`,
    `fill_rate=${stats.fill_rate.toFixed(4)}`,
    `win_rate=${stats.win_rate.toFixed(4)}`,
    `evidence_fill_rate=${stats.evidence_fill_rate.toFixed(4)}`,
    `evidence_win_rate=${stats.evidence_win_rate.toFixed(4)}`,
    `expected_value_pts=${stats.expected_value_pts}`,
    `expected_value_notional=${stats.expected_value_notional}`,
    `max_risk_notional=${stats.max_risk_notional}`,
    `currencies=${stats.currency_set.join("|")}`,
    `mc_iterations=${result.monteCarlo.iterations}`,
    `mc_p05=${result.monteCarlo.p05_total_pnl_pts}`,
    `mc_p05_notional=${result.monteCarlo.p05_total_pnl_notional}`,
    `normalized_legacy_aliases=${stats.normalized_legacy_alias_count}`,
    `blocked_legacy_aliases=${stats.blocked_legacy_alias_count}`,
    `historical_snapshots=${stats.historical_snapshot_count}`,
    `route_unresolved=${stats.route_unresolved_count}`,
    `paper_exploration_only=${stats.paper_exploration_only_count}`,
    `execution_ineligible=${stats.execution_ineligible_count}`,
    `source_total=${stats.source_intent_count}`,
    `risk_approved=${stats.risk_approved_intent_count}`,
    `risk_filtered=${stats.risk_filtered_intent_count}`,
    `downside_filtered=${stats.downside_filtered_intent_count}`,
    `unknown_point_value_filtered=${stats.risk_filter.unknownPointValueFilteredCount}`,
    `downside_best_p05=${stats.risk_filter.downsideFilter.bestCandidate?.p05_total_pnl_pts ?? 0}`,
    `downside_selected=${stats.risk_filter.downsideFilter.selectedSymbols.join("|")}`,
    `tail_repair=${result.tailRiskRepair.status}`,
    `repair_candidates=${result.tailRiskRepair.actionableRepairCandidates.length}`,
    `tail_feasibility=${result.tailRiskRepair.tailPassFeasibility.infeasibleSelectedCount}/${result.tailRiskRepair.tailPassFeasibility.selectedCount}`,
    `empirical_tail=${result.empiricalTailEvidence.status}`,
    `empirical_samples=${result.empiricalTailEvidence.outcomeStats.sampleCount}`,
  ].join(" ") + "\n",
);
