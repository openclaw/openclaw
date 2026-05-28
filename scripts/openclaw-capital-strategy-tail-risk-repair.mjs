#!/usr/bin/env node
/**
 * openclaw-capital-strategy-tail-risk-repair.mjs
 *
 * Converts the strategy fill tail-risk diagnostics into an executable paper
 * repair plan. This plan is advisory/paper-only: it does not mutate broker
 * state, send orders, relax gates, or claim simulated outcomes are live PnL.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { qualifyOpenClawPnpmCommands } from "./lib/openclaw-command-surface.mjs";
import { runStrategyFillSimulation } from "./openclaw-capital-strategy-fill-simulator.mjs";

const SCHEMA = "openclaw.capital.strategy-tail-risk-repair-plan.v1";
const MAX_STOP_HIT_RATE = 0.05;

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeJsonWithSha(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function roundNumber(value, decimals = 6) {
  const scale = 10 ** decimals;
  return Math.round(Number(value) * scale) / scale;
}

function selectedDiagnostics(strategyFill) {
  return safeArray(strategyFill?.tailRiskRepair?.tailPassFeasibility?.selectedDiagnostics);
}

function empiricalEvidence(strategyFill) {
  return (
    strategyFill?.tailRiskRepair?.tailPassFeasibility?.empiricalTailEvidence ??
    strategyFill?.empiricalTailEvidence ??
    {}
  );
}

function maxRequiredConfidence(diagnostics) {
  const values = diagnostics
    .map((diagnostic) =>
      finiteNumber(diagnostic?.tailPassFeasibility?.requiredConfidenceForPositiveP05),
    )
    .filter((value) => value !== null);
  return values.length > 0 ? Math.max(...values) : null;
}

function selectedModeledLossProbability(diagnostics) {
  const values = diagnostics
    .map((diagnostic) => finiteNumber(diagnostic?.tailPassFeasibility?.modeledLossProbability))
    .filter((value) => value !== null);
  if (values.length === 0) {
    return null;
  }
  return roundNumber(Math.max(...values), 6);
}

function diagnosticSummary(diagnostic) {
  const tailPassFeasibility = diagnostic?.tailPassFeasibility ?? {};
  return {
    symbol: String(diagnostic?.symbol ?? ""),
    intentId: String(diagnostic?.intentId ?? ""),
    targetId: String(diagnostic?.targetId ?? ""),
    marketCode: String(diagnostic?.marketCode ?? ""),
    status: String(diagnostic?.status ?? ""),
    repairAction: String(diagnostic?.repairAction ?? ""),
    reasons: safeArray(diagnostic?.reasons),
    side: String(diagnostic?.side ?? ""),
    direction: String(diagnostic?.direction ?? ""),
    routeReady: diagnostic?.routeReady === true,
    resolverReady: diagnostic?.resolverReady !== false,
    historicalSnapshot: diagnostic?.historicalSnapshot === true,
    paperExplorationOnly: diagnostic?.paperExplorationOnly === true,
    executionEligible: diagnostic?.executionEligible !== false,
    promotionBlocked: diagnostic?.promotionBlocked === true,
    sourceFreshnessStatus: String(diagnostic?.sourceFreshnessStatus ?? ""),
    sourceWallClockAgeSeconds: finiteNumber(diagnostic?.sourceWallClockAgeSeconds),
    pointValueConfidence: String(diagnostic?.pointValueConfidence ?? ""),
    currency: String(diagnostic?.currency ?? ""),
    riskPts: finiteNumber(diagnostic?.riskPts),
    rewardPts: finiteNumber(diagnostic?.rewardPts),
    riskNotional: finiteNumber(diagnostic?.riskNotional),
    rewardNotional: finiteNumber(diagnostic?.rewardNotional),
    confidence: finiteNumber(diagnostic?.confidence),
    modeledLossProbability: finiteNumber(tailPassFeasibility.modeledLossProbability),
    requiredConfidenceForPositiveP05: finiteNumber(
      tailPassFeasibility.requiredConfidenceForPositiveP05,
    ),
  };
}

function topDiagnostics(diagnostics, limit = 5) {
  return diagnostics.slice(0, limit).map(diagnosticSummary);
}

function diagnosticsMatching(diagnostics, predicate) {
  return diagnostics.filter((diagnostic) => predicate(diagnostic)).map(diagnosticSummary);
}

function comparePaperCandidatePriority(left, right) {
  const leftRisk = finiteNumber(left?.riskNotional) ?? Number.POSITIVE_INFINITY;
  const rightRisk = finiteNumber(right?.riskNotional) ?? Number.POSITIVE_INFINITY;
  if (leftRisk !== rightRisk) {
    return leftRisk - rightRisk;
  }
  const leftConfidence = finiteNumber(left?.confidence) ?? 0;
  const rightConfidence = finiteNumber(right?.confidence) ?? 0;
  if (leftConfidence !== rightConfidence) {
    return rightConfidence - leftConfidence;
  }
  return String(left?.symbol ?? "").localeCompare(String(right?.symbol ?? ""));
}

function exposureDirection(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (["buy", "long"].includes(normalized)) {
    return "long";
  }
  if (["sell", "short"].includes(normalized)) {
    return "short";
  }
  return "";
}

function marketGroupForSymbol(symbol, marketCode = "") {
  const rawCode = String(marketCode || symbol).toUpperCase();
  const alnumCode = rawCode.replace(/[^A-Z0-9]/g, "");
  const code = rawCode.replace(/[^A-Z]/g, "");
  if (["6C", "CD", "CD0000", "CAD"].includes(alnumCode) || ["CD", "CAD"].includes(code)) {
    return "fx";
  }
  if (["ES", "MES", "NQ", "MNQ", "YM", "MYM"].includes(code)) {
    return "us_equity_index";
  }
  if (["CL", "MCL", "QM", "BZ"].includes(code)) {
    return "energy";
  }
  if (["GC", "MGC", "SI", "SIL"].includes(code)) {
    return "metal";
  }
  if (["CN", "A50"].includes(code)) {
    return "china_index";
  }
  if (["TX", "TXF", "MTX"].includes(code)) {
    return "taiwan_index";
  }
  return code || "unknown";
}

function buildCandidateQualityEvidence({ candidates, selectedDiagnostics, sameCaseRerunEvidence }) {
  const selectedDirections = selectedDiagnostics
    .map((diagnostic) => exposureDirection(diagnostic.direction || diagnostic.side))
    .filter(Boolean);
  const selectedGroups = [
    ...new Set(
      selectedDiagnostics.map((diagnostic) =>
        marketGroupForSymbol(diagnostic.symbol, diagnostic.marketCode),
      ),
    ),
  ].filter((group) => group !== "unknown");
  const candidateEvidence = candidates.map((candidate) => {
    const direction = exposureDirection(candidate.direction || candidate.side);
    const marketGroup = marketGroupForSymbol(candidate.symbol, candidate.marketCode);
    const sourceFresh =
      candidate.sourceFreshnessStatus === "fresh" ||
      (candidate.sourceWallClockAgeSeconds !== null && candidate.sourceWallClockAgeSeconds <= 300);
    const freshResolved =
      candidate.routeReady === true &&
      candidate.resolverReady !== false &&
      candidate.historicalSnapshot !== true &&
      candidate.paperExplorationOnly !== true &&
      sourceFresh;
    const knownPointValue =
      candidate.currency !== "" &&
      candidate.currency !== "POINT" &&
      candidate.riskNotional !== null &&
      candidate.riskNotional > 0;
    const oppositeExposure =
      direction !== "" &&
      selectedDirections.length > 0 &&
      selectedDirections.some((selectedDirection) => selectedDirection !== direction);
    const crossGroupProxy =
      marketGroup !== "unknown" &&
      selectedGroups.length > 0 &&
      !selectedGroups.includes(marketGroup);
    return {
      symbol: candidate.symbol,
      intentId: candidate.intentId,
      marketGroup,
      direction,
      freshResolved,
      knownPointValue,
      oppositeExposure,
      crossGroupProxy,
      sourceFreshnessStatus: candidate.sourceFreshnessStatus,
      sourceWallClockAgeSeconds: candidate.sourceWallClockAgeSeconds,
      riskNotional: candidate.riskNotional,
      confidence: candidate.confidence,
    };
  });
  const freshResolvedCount = candidateEvidence.filter(
    (candidate) => candidate.freshResolved,
  ).length;
  const knownPointValueCount = candidateEvidence.filter(
    (candidate) => candidate.knownPointValue,
  ).length;
  const oppositeExposureCount = candidateEvidence.filter(
    (candidate) => candidate.oppositeExposure,
  ).length;
  const crossGroupProxyCount = candidateEvidence.filter(
    (candidate) => candidate.crossGroupProxy,
  ).length;
  const replayTailPass = sameCaseRerunEvidence?.replayOutcome?.replayTailPass === true;
  const status =
    candidates.length === 0
      ? "blocked_no_candidates"
      : replayTailPass
        ? "same_case_replay_tail_passed"
        : sameCaseRerunEvidence?.status === "rerun_completed_still_blocked"
          ? "same_case_replay_still_blocked"
          : freshResolvedCount === candidates.length &&
              knownPointValueCount === candidates.length &&
              (oppositeExposureCount > 0 || crossGroupProxyCount > 0)
            ? "candidate_quality_ready_for_rerun"
            : "blocked_candidate_quality_incomplete";
  return {
    schema: "openclaw.capital.strategy-tail-risk-candidate-quality-evidence.v1",
    status,
    sourceBucket: "fresh_resolved_low_correlation_or_opposite_exposure",
    selectedCandidateCount: candidates.length,
    selectedMarketGroups: selectedGroups,
    freshResolvedCount,
    knownPointValueCount,
    oppositeExposureCount,
    crossGroupProxyCount,
    replayTailPass,
    candidates: candidateEvidence,
    requiredPass: [
      "freshResolvedCount == selectedCandidateCount",
      "knownPointValueCount == selectedCandidateCount",
      "oppositeExposureCount > 0 or crossGroupProxyCount > 0",
      "same-case replay p05_total_pnl_pts > 0",
      "same-case replay p05_total_pnl_notional > 0",
    ],
    safetyLock: {
      paperOnly: true,
      simulatedOnly: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      noLiveOrderSent: true,
    },
    noOrderWrite: true,
    machineLine: `candidateQualityEvidence=${status};freshResolved=${freshResolvedCount}/${candidates.length};knownPointValue=${knownPointValueCount}/${candidates.length};opposite=${oppositeExposureCount};crossGroupProxy=${crossGroupProxyCount};replayTailPass=${replayTailPass};noOrderWrite=true`,
  };
}

function buildReplayOutcome(replayOutcome) {
  const replay = plainObject(replayOutcome);
  const replayCandidate = plainObject(replay.replayCandidate);
  const currentCandidate = plainObject(replay.currentCandidate);
  const failedReplayHistory = plainObject(replay.failedReplayHistory);
  const replayStatus = String(replay.status ?? "");
  if (!replayStatus || replayStatus === "not_evaluated") {
    return null;
  }
  return {
    schema: "openclaw.capital.strategy-tail-risk-rerun-outcome.v1",
    status: replayStatus,
    selectedSymbols: safeArray(replay.selectedSymbols).map((symbol) => String(symbol)),
    selectedCandidateCount: finiteNumber(replay.selectedCandidateCount) ?? 0,
    replayP05Pts: finiteNumber(replayCandidate.p05_total_pnl_pts),
    replayP05Notional: finiteNumber(replayCandidate.p05_total_pnl_notional),
    replayTailPass: replayCandidate.tailPass === true,
    currentP05Pts: finiteNumber(currentCandidate.p05_total_pnl_pts),
    currentP05Notional: finiteNumber(currentCandidate.p05_total_pnl_notional),
    replayBetterThanCurrent: replay.replayBetterThanCurrent === true,
    followUpCommand: String(replay.followUpCommand ?? ""),
    noOrderWrite: replay.noOrderWrite === true,
    failedReplayHistory,
    machineLine: String(replay.machineLine ?? ""),
  };
}

function normalizedReplaySymbols(symbols) {
  return [
    ...new Set(
      safeArray(symbols)
        .map((symbol) => String(symbol ?? "").toUpperCase())
        .filter(Boolean),
    ),
  ].toSorted();
}

function buildRiskResizedRejectionExclusion(report) {
  const reportRead =
    report &&
    typeof report === "object" &&
    report.schema === "openclaw.capital.risk-resized-paper-intent-rerun-gate.v1";
  const rejectionSummary = plainObject(report?.rejectionSummary);
  const rejectedCandidates = safeArray(rejectionSummary.rejectedCandidates).map(plainObject);
  const rejectedSymbols = normalizedReplaySymbols(
    rejectedCandidates.map((candidate) => candidate.symbol),
  );
  const allRejected =
    rejectionSummary.status === "all_candidates_rejected" && rejectedSymbols.length > 0;
  const rejectedP05Pts = rejectedCandidates
    .filter((candidate) => rejectedSymbols.includes(String(candidate.symbol ?? "").toUpperCase()))
    .map((candidate) => ({
      symbol: String(candidate.symbol ?? "").toUpperCase(),
      p05TotalPnlPts: finiteNumber(candidate.p05TotalPnlPts),
      p05TotalPnlNotional: finiteNumber(candidate.p05TotalPnlNotional),
      rejectionReasons: safeArray(candidate.rejectionReasons).map((reason) => String(reason)),
    }));
  const status = reportRead && allRejected ? "active_rejected_candidates_excluded" : "inactive";
  return {
    schema: "openclaw.capital.strategy-tail-risk-risk-resized-rejection-exclusion.v1",
    status,
    sourceStatus: String(report?.status ?? ""),
    sourceSummaryStatus: String(rejectionSummary.status ?? ""),
    sourceGeneratedAt: String(report?.generatedAt ?? ""),
    rejectedSymbols,
    rejectedCount: rejectedSymbols.length,
    rejectedP05Pts,
    requiredNextEvidence: [
      "new quote digest or new signal for rejected symbols",
      "fresh resolved candidate not in rejected risk-resized rerun set",
      "same-case p05_total_pnl_pts > 0",
      "same-case p05_total_pnl_notional > 0",
    ],
    safetyLock: {
      paperOnly: true,
      simulatedOnly: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      noLiveOrderSent: true,
    },
    noOrderWrite: true,
    machineLine: `riskResizedRejectionExclusion=${status};rejected=${rejectedSymbols.join("|") || "none"};source=${rejectionSummary.status ?? "missing"};noOrderWrite=true`,
  };
}

function failedReplaySymbolsFromReplayOutcome(replayOutcome) {
  const replay = plainObject(replayOutcome);
  const failedReplayHistory = plainObject(replay.failedReplayHistory);
  const activeSymbols = normalizedReplaySymbols([
    ...safeArray(replay.excludedFailedReplaySymbols),
    ...safeArray(failedReplayHistory.excludedSymbols),
  ]);
  if (replay.status === "candidate_batch_tail_passed_requires_promotion_rerun") {
    return [];
  }
  if (replay.status === "candidate_batch_replayed_still_blocked") {
    return normalizedReplaySymbols([...activeSymbols, ...safeArray(replay.selectedSymbols)]);
  }
  return activeSymbols;
}

function buildSameCaseRerunEvidence({
  candidates,
  currentP05Pts,
  currentP05Notional,
  replayOutcome,
  failedReplayExcluded = false,
}) {
  const ranking = candidates
    .map((candidate) => {
      const riskPts = finiteNumber(candidate.riskPts);
      const riskNotional = finiteNumber(candidate.riskNotional);
      const modeledLossProbability = finiteNumber(candidate.modeledLossProbability);
      return {
        symbol: candidate.symbol,
        intentId: candidate.intentId,
        rankReason: "least_negative_p05_drag_proxy_notional_then_confidence",
        riskPts,
        riskNotional,
        confidence: finiteNumber(candidate.confidence),
        modeledLossProbability,
        requiredConfidenceForPositiveP05: finiteNumber(candidate.requiredConfidenceForPositiveP05),
        p05DragProxyPts:
          riskPts === null || modeledLossProbability === null || modeledLossProbability < 0.05
            ? 0
            : roundNumber(-riskPts),
        p05DragProxyNotional:
          riskNotional === null || modeledLossProbability === null || modeledLossProbability < 0.05
            ? 0
            : roundNumber(-riskNotional),
        requiresSameCaseRerun: true,
      };
    })
    .toSorted((left, right) => {
      if (right.p05DragProxyNotional !== left.p05DragProxyNotional) {
        return right.p05DragProxyNotional - left.p05DragProxyNotional;
      }
      return (right.confidence ?? 0) - (left.confidence ?? 0);
    })
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
  const replayResult = buildReplayOutcome(replayOutcome);
  const replayStillBlocked = replayResult?.status === "candidate_batch_replayed_still_blocked";
  const status =
    replayResult?.status === "candidate_batch_tail_passed_requires_promotion_rerun"
      ? "rerun_completed_tail_passed_requires_promotion_rerun"
      : replayStillBlocked && ranking.length === 0
        ? "blocked_no_candidates"
        : replayStillBlocked && failedReplayExcluded
          ? "ready_for_next_same_case_rerun"
          : replayStillBlocked
            ? "rerun_completed_still_blocked"
            : ranking.length > 0
              ? "ready_for_same_case_rerun"
              : "blocked_no_candidates";
  const followUpCommand =
    status === "rerun_completed_still_blocked"
      ? "pnpm capital:trade:current-paper-intents"
      : "pnpm capital:strategy:fill-simulation:check";
  return {
    schema: "openclaw.capital.strategy-tail-risk-same-case-rerun-evidence.v1",
    status,
    evidenceMode: "diagnostic_p05_drag_proxy_requires_rerun",
    currentP05Pts,
    currentP05Notional,
    rankedBy: "least_negative_p05_drag_proxy_notional_then_confidence",
    candidateContributionRanking: ranking,
    replayOutcome: replayResult,
    followUpCommand,
    requiredEvidence: [
      "rerun same-case strategy fill simulation",
      "compare candidate basket p05_total_pnl_pts",
      "compare candidate basket p05_total_pnl_notional",
      "keep promotion gate paper-only",
    ],
    safetyLock: {
      paperOnly: true,
      simulatedOnly: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      noLiveOrderSent: true,
    },
    noOrderWrite: true,
    machineLine: `sameCaseRerunEvidence=${status};ranked=${ranking.map((entry) => `${entry.rank}:${entry.symbol}:${entry.p05DragProxyNotional}`).join("|") || "none"};replayOutcome=${replayResult?.status ?? "not_evaluated"};replayP05=${replayResult?.replayP05Pts ?? "missing"};replayP05Notional=${replayResult?.replayP05Notional ?? "missing"};replayBetterThanCurrent=${replayResult?.replayBetterThanCurrent ?? false};failedReplayExcluded=${failedReplayExcluded};followUpCommand=${followUpCommand};noOrderWrite=true`,
  };
}

function buildFreshCandidateRefreshPlan({
  lowCorrelationCandidates,
  riskNotionalCandidates,
  selectedDiagnostics,
  nextPaperCandidateBatch,
  riskResizedRejectionExclusion,
}) {
  const selectedGroups = [
    ...new Set(
      selectedDiagnostics.map((diagnostic) =>
        marketGroupForSymbol(diagnostic.symbol, diagnostic.marketCode),
      ),
    ),
  ].filter(Boolean);
  const nextBatchSymbols = new Set(
    safeArray(nextPaperCandidateBatch?.selectedSymbols).map((symbol) =>
      String(symbol).toUpperCase(),
    ),
  );
  const excludedFailedReplaySymbols = new Set(
    safeArray(nextPaperCandidateBatch?.excludedFailedReplaySymbols).map((symbol) =>
      String(symbol).toUpperCase(),
    ),
  );
  const riskResizedRejectedSymbols = new Set(
    safeArray(riskResizedRejectionExclusion?.rejectedSymbols).map((symbol) =>
      String(symbol).toUpperCase(),
    ),
  );
  const refreshCandidates = [...lowCorrelationCandidates, ...riskNotionalCandidates]
    .map((candidate) => {
      const symbol = String(candidate.symbol ?? "").toUpperCase();
      const marketGroup = marketGroupForSymbol(symbol, candidate.marketCode);
      const failedReplayExcluded = excludedFailedReplaySymbols.has(symbol);
      const riskResizedRejected = riskResizedRejectedSymbols.has(symbol);
      const nextBatchSelected = nextBatchSymbols.has(symbol);
      const needsRiskReview = safeArray(candidate.reasons).includes("over_max_risk");
      const pointValueKnown = candidate.currency !== "" && candidate.currency !== "POINT";
      const action = nextBatchSelected
        ? "same_case_rerun_candidate"
        : failedReplayExcluded
          ? "wait_for_new_quote_digest_or_new_signal"
          : riskResizedRejected
            ? "wait_for_new_signal_after_risk_resized_rejection"
            : needsRiskReview
              ? "risk_notional_review_before_rerun"
              : "refresh_quote_and_rebuild_current_paper_intents";
      return {
        symbol,
        marketCode: String(candidate.marketCode ?? ""),
        marketGroup,
        targetId: String(candidate.targetId ?? ""),
        action,
        crossGroupProxy: selectedGroups.length > 0 && !selectedGroups.includes(marketGroup),
        failedReplayExcluded,
        riskResizedRejected,
        nextBatchSelected,
        pointValueKnown,
        needsRiskReview,
        sourceFreshnessStatus: String(candidate.sourceFreshnessStatus ?? ""),
        sourceWallClockAgeSeconds: finiteNumber(candidate.sourceWallClockAgeSeconds),
        riskNotional: finiteNumber(candidate.riskNotional),
        confidence: finiteNumber(candidate.confidence),
      };
    })
    .toSorted((left, right) => {
      if (left.nextBatchSelected !== right.nextBatchSelected) {
        return left.nextBatchSelected ? -1 : 1;
      }
      if (left.failedReplayExcluded !== right.failedReplayExcluded) {
        return left.failedReplayExcluded ? 1 : -1;
      }
      if (left.riskResizedRejected !== right.riskResizedRejected) {
        return left.riskResizedRejected ? 1 : -1;
      }
      if (left.needsRiskReview !== right.needsRiskReview) {
        return left.needsRiskReview ? 1 : -1;
      }
      const leftRisk = left.riskNotional ?? Number.POSITIVE_INFINITY;
      const rightRisk = right.riskNotional ?? Number.POSITIVE_INFINITY;
      if (leftRisk !== rightRisk) {
        return leftRisk - rightRisk;
      }
      return left.symbol.localeCompare(right.symbol);
    });
  const readyCount = refreshCandidates.filter((candidate) => candidate.nextBatchSelected).length;
  const refreshableCount = refreshCandidates.filter(
    (candidate) =>
      !candidate.failedReplayExcluded &&
      !candidate.riskResizedRejected &&
      !candidate.needsRiskReview,
  ).length;
  const status =
    readyCount > 0
      ? "ready_to_rerun_fresh_candidates"
      : refreshableCount > 0
        ? "refresh_candidates_available"
        : refreshCandidates.length > 0
          ? "blocked_waiting_new_quote_digest_or_risk_review"
          : "missing_fresh_candidate_pool";
  return {
    schema: "openclaw.capital.strategy-tail-risk-fresh-candidate-refresh-plan.v1",
    status,
    selectedMarketGroups: selectedGroups,
    candidateCount: refreshCandidates.length,
    readyRerunCandidateCount: readyCount,
    refreshableCandidateCount: refreshableCount,
    failedReplayExcludedCount: refreshCandidates.filter(
      (candidate) => candidate.failedReplayExcluded,
    ).length,
    riskResizedRejectedCount: refreshCandidates.filter((candidate) => candidate.riskResizedRejected)
      .length,
    riskReviewCandidateCount: refreshCandidates.filter((candidate) => candidate.needsRiskReview)
      .length,
    riskResizedRejectionExclusion,
    subscriptionSymbols: refreshCandidates.map((candidate) => candidate.symbol),
    candidates: refreshCandidates,
    commands: {
      refreshCurrentPaperIntents: "pnpm capital:trade:current-paper-intents:check",
      rerunFillSimulation: "pnpm capital:strategy:fill-simulation:check",
      rerunTailRiskRepair: "pnpm capital:strategy:tail-risk-repair:check",
    },
    requiredEvidence: [
      "BrokerDesk fresh quote event or symbol cache update",
      "routeStatus=resolved",
      "sourceWallClockAgeSeconds <= 300",
      "known non-POINT point value",
      "same-case p05_total_pnl_pts > 0 and p05_total_pnl_notional > 0",
    ],
    safetyLock: {
      paperOnly: true,
      simulatedOnly: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      noLiveOrderSent: true,
    },
    noOrderWrite: true,
    machineLine: `freshCandidateRefreshPlan=${status};ready=${readyCount};refreshable=${refreshableCount};failedReplayExcluded=${refreshCandidates.filter((candidate) => candidate.failedReplayExcluded).length};riskResizedRejected=${refreshCandidates.filter((candidate) => candidate.riskResizedRejected).length};riskReview=${refreshCandidates.filter((candidate) => candidate.needsRiskReview).length};symbols=${refreshCandidates.map((candidate) => candidate.symbol).join("|") || "none"};noOrderWrite=true`,
  };
}

function buildRiskNotionalReviewPlan({
  riskNotionalCandidates,
  strategyFill,
  riskResizedRejectionExclusion,
}) {
  const maxRiskNotional = finiteNumber(strategyFill?.stats?.risk_filter?.maxRiskNotional);
  const riskResizedRejectedSymbols = new Set(
    safeArray(riskResizedRejectionExclusion?.rejectedSymbols).map((symbol) =>
      String(symbol).toUpperCase(),
    ),
  );
  const reviewCandidates = riskNotionalCandidates.map((candidate) => {
    const symbol = String(candidate.symbol ?? "").toUpperCase();
    const riskPts = finiteNumber(candidate.riskPts);
    const riskNotional = finiteNumber(candidate.riskNotional);
    const rewardPts = finiteNumber(candidate.rewardPts);
    const rewardNotional = finiteNumber(candidate.rewardNotional);
    const impliedPointValue =
      riskPts !== null && riskPts > 0 && riskNotional !== null
        ? roundNumber(riskNotional / riskPts)
        : null;
    const targetRiskNotional =
      maxRiskNotional !== null && maxRiskNotional > 0 ? maxRiskNotional : null;
    const riskScale =
      targetRiskNotional !== null && riskNotional !== null && riskNotional > 0
        ? roundNumber(targetRiskNotional / riskNotional, 6)
        : null;
    const riskResizedRejected = riskResizedRejectedSymbols.has(symbol);
    const paperReviewRiskPts =
      riskScale !== null && riskPts !== null ? roundNumber(riskPts * riskScale, 6) : null;
    const paperReviewRewardPts =
      riskScale !== null && rewardPts !== null ? roundNumber(rewardPts * riskScale, 6) : null;
    const pointValueKnown = candidate.currency !== "" && candidate.currency !== "POINT";
    const reviewAction = riskResizedRejected
      ? "paper_only_rejected_by_risk_resized_same_case_rerun"
      : targetRiskNotional === null
        ? "blocked_missing_max_risk_notional"
        : riskScale !== null && riskScale > 0 && riskScale <= 1
          ? "paper_only_reduce_risk_pts_or_use_smaller_contract_then_rerun"
          : "risk_notional_already_within_cap";
    return {
      symbol,
      marketCode: String(candidate.marketCode ?? ""),
      marketGroup: marketGroupForSymbol(candidate.symbol, candidate.marketCode),
      targetId: String(candidate.targetId ?? ""),
      currentRiskPts: riskPts,
      currentRewardPts: rewardPts,
      currentRiskNotional: riskNotional,
      currentRewardNotional: rewardNotional,
      currency: String(candidate.currency ?? ""),
      pointValueKnown,
      impliedPointValue,
      maxRiskNotional: targetRiskNotional,
      riskScale,
      paperReviewRiskPts,
      paperReviewRewardPts,
      riskResizedRejected,
      reviewAction,
      canAutoApply: false,
      reason: riskResizedRejected
        ? "Latest paper-only risk-resized same-case rerun kept p05 negative; exclude this candidate until new quote digest or new signal evidence appears."
        : "Risk sizing review is paper-only evidence; it must be regenerated as a new paper intent and pass same-case tail simulation before promotion.",
    };
  });
  const actionableCount = reviewCandidates.filter(
    (candidate) =>
      candidate.reviewAction === "paper_only_reduce_risk_pts_or_use_smaller_contract_then_rerun",
  ).length;
  const status =
    reviewCandidates.length === 0
      ? "clear"
      : actionableCount > 0
        ? "requires_paper_risk_resizing_review"
        : reviewCandidates.some((candidate) => candidate.riskResizedRejected)
          ? "blocked_all_candidates_rejected"
          : "blocked_missing_risk_cap";
  return {
    schema: "openclaw.capital.strategy-tail-risk-notional-review-plan.v1",
    status,
    maxRiskNotional,
    candidateCount: reviewCandidates.length,
    actionableCandidateCount: actionableCount,
    riskResizedRejectedCandidateCount: reviewCandidates.filter(
      (candidate) => candidate.riskResizedRejected,
    ).length,
    riskResizedRejectionExclusion,
    candidates: reviewCandidates,
    requiredEvidence: [
      "paper-only regenerated intent",
      "riskNotional <= maxRiskNotional",
      "known point value and currency",
      "same-case p05_total_pnl_pts > 0",
      "same-case p05_total_pnl_notional > 0",
    ],
    forbiddenShortcut: [
      "do not reduce live order risk outside operator-owned adapter",
      "do not lower maxRiskNotional gate",
      "do not promote sizing-only repair without positive p05",
    ],
    safetyLock: {
      paperOnly: true,
      simulatedOnly: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      noLiveOrderSent: true,
    },
    noOrderWrite: true,
    machineLine: `riskNotionalReviewPlan=${status};maxRiskNotional=${maxRiskNotional ?? "missing"};candidates=${reviewCandidates.map((candidate) => candidate.symbol).join("|") || "none"};actionable=${actionableCount};riskResizedRejected=${
      reviewCandidates
        .filter((candidate) => candidate.riskResizedRejected)
        .map((candidate) => candidate.symbol)
        .join("|") || "none"
    };noOrderWrite=true`,
  };
}

function buildNextPaperCandidateBatch({
  lowCorrelationCandidates,
  selectedDiagnostics,
  selectedSymbols,
  currentP05Pts,
  currentP05Notional,
  replayOutcome,
}) {
  const excludedFailedReplaySymbols = failedReplaySymbolsFromReplayOutcome(replayOutcome);
  const excludedFailedReplaySymbolSet = new Set(excludedFailedReplaySymbols);
  const skippedFailedReplayCandidateCount = lowCorrelationCandidates.filter((candidate) =>
    excludedFailedReplaySymbolSet.has(String(candidate.symbol ?? "").toUpperCase()),
  ).length;
  const availableCandidates = lowCorrelationCandidates.filter(
    (candidate) => !excludedFailedReplaySymbolSet.has(String(candidate.symbol ?? "").toUpperCase()),
  );
  const selectedCandidates = availableCandidates
    .toSorted(comparePaperCandidatePriority)
    .slice(0, 3);
  const status =
    selectedCandidates.length > 0 ? "ready_to_refresh_and_rerun" : "blocked_no_candidate_batch";
  const sameCaseRerunEvidence = buildSameCaseRerunEvidence({
    candidates: selectedCandidates,
    currentP05Pts,
    currentP05Notional,
    replayOutcome,
    failedReplayExcluded: skippedFailedReplayCandidateCount > 0,
  });
  const candidateQualityEvidence = buildCandidateQualityEvidence({
    candidates: selectedCandidates,
    selectedDiagnostics,
    sameCaseRerunEvidence,
  });
  return {
    schema: "openclaw.capital.strategy-tail-risk-next-paper-candidate-batch.v1",
    status,
    sourceBucket: "fresh_resolved_low_correlation_or_opposite_exposure",
    selectedSymbols: selectedCandidates.map((candidate) => candidate.symbol),
    selectedCandidateCount: selectedCandidates.length,
    excludedCurrentSymbols: selectedSymbols,
    excludedFailedReplaySymbols,
    skippedFailedReplayCandidateCount,
    availableAfterExclusionCount: availableCandidates.length,
    candidates: selectedCandidates,
    sameCaseRerunEvidence,
    candidateQualityEvidence,
    command: "pnpm capital:trade:current-paper-intents",
    validationCommand: "pnpm capital:trade:current-paper-intents:check",
    followUpCommand: "pnpm capital:strategy:fill-simulation:check",
    rerunRequired: true,
    requiredRerunEvidence: [
      "same-case strategy fill rerun",
      "p05_total_pnl_pts > 0",
      "p05_total_pnl_notional > 0",
      "promotion gate remains paper-only",
    ],
    safetyLock: {
      paperOnly: true,
      simulatedOnly: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      noLiveOrderSent: true,
    },
    noOrderWrite: true,
    machineLine: `nextPaperCandidateBatch=${status};selected=${selectedCandidates.map((candidate) => candidate.symbol).join("|") || "none"};candidateCount=${selectedCandidates.length};excludedFailedReplay=${excludedFailedReplaySymbols.join("|") || "none"};skippedFailedReplay=${skippedFailedReplayCandidateCount};availableAfterExclusion=${availableCandidates.length};${sameCaseRerunEvidence.machineLine};${candidateQualityEvidence.machineLine};followUpCommand=pnpm capital:strategy:fill-simulation:check;noOrderWrite=true`,
  };
}

function buildRepairCandidatePlan({ strategyFill, empirical, riskResizedRejectionExclusion }) {
  const tailRiskRepair = strategyFill?.tailRiskRepair ?? {};
  const allDiagnostics = safeArray(tailRiskRepair.rejectedIntentDiagnostics);
  const selectedSymbols = safeArray(tailRiskRepair.selectedSymbols).map((symbol) =>
    String(symbol).toUpperCase(),
  );
  const lowCorrelationCandidates = diagnosticsMatching(
    allDiagnostics,
    (diagnostic) =>
      diagnostic?.selected !== true &&
      String(diagnostic?.repairAction ?? "") ===
        "combine_with_low_correlation_candidate_or_reduce_tail_loss",
  );
  const pointValueBackfillCandidates = diagnosticsMatching(allDiagnostics, (diagnostic) =>
    safeArray(diagnostic?.reasons).includes("unknown_point_value"),
  );
  const riskNotionalCandidates = diagnosticsMatching(allDiagnostics, (diagnostic) =>
    safeArray(diagnostic?.reasons).includes("over_max_risk"),
  );
  const selectedDiagnosticsNeedingConfidence = diagnosticsMatching(
    allDiagnostics,
    (diagnostic) =>
      diagnostic?.selected === true &&
      diagnostic?.tailPassFeasibility?.feasibleWithCurrentConfidence !== true,
  );
  const selectedDiagnosticSummaries = diagnosticsMatching(
    allDiagnostics,
    (diagnostic) => diagnostic?.selected === true,
  );
  const stopHitRate = finiteNumber(empirical?.outcomeStats?.stopHitRate);
  const sampleCount = finiteNumber(empirical?.outcomeStats?.sampleCount) ?? 0;
  const nextPaperCandidateBatch = buildNextPaperCandidateBatch({
    lowCorrelationCandidates,
    selectedDiagnostics: selectedDiagnosticSummaries,
    selectedSymbols,
    currentP05Pts: finiteNumber(tailRiskRepair.currentP05Pts) ?? 0,
    currentP05Notional: finiteNumber(tailRiskRepair.currentP05Notional) ?? 0,
    replayOutcome: tailRiskRepair.repairCandidateReplay,
  });
  const freshCandidateRefreshPlan = buildFreshCandidateRefreshPlan({
    lowCorrelationCandidates,
    riskNotionalCandidates,
    selectedDiagnostics: selectedDiagnosticSummaries,
    nextPaperCandidateBatch,
    riskResizedRejectionExclusion,
  });
  const riskNotionalReviewPlan = buildRiskNotionalReviewPlan({
    riskNotionalCandidates,
    strategyFill,
    riskResizedRejectionExclusion,
  });
  const buckets = [
    {
      id: "fresh_resolved_low_correlation_or_opposite_exposure",
      status: lowCorrelationCandidates.length > 0 ? "candidate_pool_present" : "missing",
      candidateCount: lowCorrelationCandidates.length,
      candidates: lowCorrelationCandidates,
      requiredEvidence: [
        "fresh resolved paper intent",
        "independent correlation/opposite-exposure evidence",
        "same-case p05_total_pnl_pts > 0 after rerun",
      ],
    },
    {
      id: "contract_point_value_currency_backfill",
      status: pointValueBackfillCandidates.length > 0 ? "required" : "satisfied_for_current_pool",
      candidateCount: pointValueBackfillCandidates.length,
      candidates: pointValueBackfillCandidates,
      requiredEvidence: ["official contract point value", "pointValueCurrency != POINT"],
    },
    {
      id: "risk_notional_cap_review",
      status: riskNotionalCandidates.length > 0 ? "required_before_selection" : "clear",
      candidateCount: riskNotionalCandidates.length,
      candidates: riskNotionalCandidates,
      requiredEvidence: ["riskNotional <= maxRiskNotional", "qty/riskPts review before rerun"],
    },
    {
      id: "selected_signal_confidence_recheck",
      status:
        selectedDiagnosticsNeedingConfidence.length > 0
          ? "required"
          : "clear_for_current_selection",
      candidateCount: selectedDiagnosticsNeedingConfidence.length,
      candidates: selectedDiagnosticsNeedingConfidence,
      selectedSymbols,
      requiredEvidence: ["requiredConfidenceForPositiveP05 <= 1", "modeledLossProbability < 0.05"],
    },
    {
      id: "empirical_stop_hit_calibration",
      status:
        stopHitRate !== null && sampleCount >= 50 && stopHitRate <= MAX_STOP_HIT_RATE
          ? "ready_for_same_case_calibration"
          : "blocked",
      sampleCount,
      stopHitRate,
      requiredStopHitRate: MAX_STOP_HIT_RATE,
      requiredEvidence: ["paper outcome sampleCount >= 50", "paper stopHitRate <= 0.05"],
    },
    {
      id: "same_case_rerun",
      status: "required_after_candidate_or_calibration_update",
      command: "pnpm capital:strategy:fill-simulation:check",
      requiredEvidence: [
        "same input cycle rerun",
        "p05_total_pnl_pts > 0",
        "p05_total_pnl_notional > 0",
        "promotionGate.status=ready_for_paper_promotion",
      ],
    },
  ];
  return {
    status:
      stopHitRate !== null && sampleCount >= 50 && stopHitRate <= MAX_STOP_HIT_RATE
        ? "candidate_or_calibration_ready_for_rerun"
        : "needs_candidate_or_outcome_evidence",
    selectedSymbols,
    currentCandidateIntentCount: Number(tailRiskRepair.candidateIntentCount ?? 0),
    positiveTailCandidateCount: Number(tailRiskRepair.positiveTailCandidateCount ?? 0),
    evaluatedSubsetCount: Number(tailRiskRepair.evaluatedSubsetCount ?? 0),
    blocker: String(tailRiskRepair.blocker ?? ""),
    topCurrentDiagnostics: topDiagnostics(allDiagnostics),
    buckets,
    nextPaperCandidateBatch,
    freshCandidateRefreshPlan,
    riskNotionalReviewPlan,
    riskResizedRejectionExclusion,
    noOrderWrite: true,
    nextValidationCommand: "pnpm capital:strategy:tail-risk-repair:check",
  };
}

function buildRepairActions({ strategyFill, diagnostics, empirical }) {
  const stopHitRate = finiteNumber(empirical?.outcomeStats?.stopHitRate);
  const sampleCount = finiteNumber(empirical?.outcomeStats?.sampleCount) ?? 0;
  const requiredConfidence = maxRequiredConfidence(diagnostics);
  const modeledLossProbability = selectedModeledLossProbability(diagnostics);
  return [
    {
      id: "collect_fresh_resolved_low_correlation_candidates",
      status: "required",
      reason:
        "current paper subset has no positive p05 candidate; need additional fresh resolved candidates before promotion.",
      requiredEvidence: [
        "routeStatus=resolved",
        "wallClockFresh=true",
        "known pointValueCurrency",
        "same-case strategy fill rerun with p05_total_pnl_pts > 0",
      ],
    },
    {
      id: "empirical_stop_hit_calibration",
      status:
        stopHitRate !== null && sampleCount >= 50 && stopHitRate <= MAX_STOP_HIT_RATE
          ? "ready_for_paper_calibration"
          : "blocked",
      reason:
        stopHitRate === null
          ? "missing outcome stop-hit rate"
          : `current stopHitRate=${stopHitRate}, required<=${MAX_STOP_HIT_RATE}`,
      sampleCount,
      stopHitRate,
      requiredStopHitRate: MAX_STOP_HIT_RATE,
    },
    {
      id: "wait_for_stronger_signal_confidence",
      status:
        requiredConfidence !== null && requiredConfidence <= 1
          ? "possible_after_signal_strengthens"
          : "blocked_current_signal_cannot_pass",
      reason:
        requiredConfidence === null
          ? "selected diagnostic missing required confidence"
          : `requiredConfidenceForPositiveP05=${requiredConfidence}`,
      requiredConfidenceForPositiveP05: requiredConfidence,
      modeledLossProbability,
    },
    {
      id: "sizing_only_repair",
      status: "ineffective",
      reason:
        "Reducing qty/riskNotional lowers loss size but does not lower modeled loss probability below the p05 threshold.",
    },
  ];
}

function buildPromotionBlockerDiagnostic({
  strategyFill,
  diagnostics,
  empirical,
  repairCandidatePlan,
}) {
  const selectedSummaries = diagnostics.map((diagnostic) => {
    const tailPassFeasibility = diagnostic?.tailPassFeasibility ?? {};
    return {
      symbol: String(diagnostic?.symbol ?? ""),
      intentId: String(diagnostic?.intentId ?? ""),
      confidence: finiteNumber(diagnostic?.confidence),
      modeledLossProbability: finiteNumber(tailPassFeasibility.modeledLossProbability),
      requiredConfidenceForPositiveP05: finiteNumber(
        tailPassFeasibility.requiredConfidenceForPositiveP05,
      ),
      feasibleWithCurrentConfidence: tailPassFeasibility.feasibleWithCurrentConfidence === true,
    };
  });
  const stopHitRate = finiteNumber(empirical?.outcomeStats?.stopHitRate);
  const sampleCount = finiteNumber(empirical?.outcomeStats?.sampleCount) ?? 0;
  const nextBatch = repairCandidatePlan?.nextPaperCandidateBatch ?? {};
  const candidateQuality = nextBatch.candidateQualityEvidence ?? {};
  const selectedNeedConfidenceCount = selectedSummaries.filter(
    (diagnostic) =>
      diagnostic.requiredConfidenceForPositiveP05 !== null &&
      diagnostic.requiredConfidenceForPositiveP05 > 1,
  ).length;
  const empiricalBlocked =
    stopHitRate === null || sampleCount < 50 || stopHitRate > MAX_STOP_HIT_RATE;
  const status =
    Number(strategyFill?.tailRiskRepair?.positiveTailCandidateCount ?? 0) > 0 &&
    selectedNeedConfidenceCount === 0 &&
    !empiricalBlocked
      ? "ready_for_same_case_rerun"
      : "blocked_current_tail_evidence";
  const blockingFactors = [
    selectedNeedConfidenceCount > 0 ? "selected_signal_confidence_above_1" : "",
    empiricalBlocked ? "empirical_stop_hit_rate_blocked" : "",
    Number(strategyFill?.tailRiskRepair?.positiveTailCandidateCount ?? 0) <= 0
      ? "no_positive_tail_candidate"
      : "",
    nextBatch.status === "blocked_no_candidate_batch" ? "no_unreplayed_candidate_batch" : "",
  ].filter(Boolean);
  return {
    schema: "openclaw.capital.strategy-tail-risk-promotion-blocker-diagnostic.v1",
    status,
    operatorDecision: "do_not_promote",
    currentP05Pts: finiteNumber(strategyFill?.tailRiskRepair?.currentP05Pts) ?? 0,
    currentP05Notional: finiteNumber(strategyFill?.tailRiskRepair?.currentP05Notional) ?? 0,
    selectedSymbols: safeArray(strategyFill?.tailRiskRepair?.selectedSymbols),
    selectedDiagnostics: selectedSummaries,
    blockingFactors,
    empiricalGate: {
      status: String(empirical?.status ?? ""),
      sampleCount,
      stopHitRate,
      requiredStopHitRate: MAX_STOP_HIT_RATE,
      pass: !empiricalBlocked,
    },
    candidateGate: {
      candidateIntentCount: Number(strategyFill?.tailRiskRepair?.candidateIntentCount ?? 0),
      evaluatedSubsetCount: Number(strategyFill?.tailRiskRepair?.evaluatedSubsetCount ?? 0),
      positiveTailCandidateCount: Number(
        strategyFill?.tailRiskRepair?.positiveTailCandidateCount ?? 0,
      ),
      nextPaperCandidateBatchStatus: String(nextBatch.status ?? ""),
      selectedCandidateCount: Number(nextBatch.selectedCandidateCount ?? 0),
      availableAfterExclusionCount: Number(nextBatch.availableAfterExclusionCount ?? 0),
      candidateQualityStatus: String(candidateQuality.status ?? ""),
      freshCandidateRefreshPlanStatus: String(
        repairCandidatePlan?.freshCandidateRefreshPlan?.status ?? "",
      ),
      riskNotionalReviewPlanStatus: String(
        repairCandidatePlan?.riskNotionalReviewPlan?.status ?? "",
      ),
    },
    requiredEvidence: [
      "fresh resolved paper candidate with wallClockFresh=true",
      "known non-POINT pointValueCurrency",
      "opposite or cross-market low-correlation exposure",
      "same-case rerun with p05_total_pnl_pts > 0 and p05_total_pnl_notional > 0",
      "paper outcome stopHitRate <= 0.05 if using empirical calibration",
    ],
    forbiddenShortcut: [
      "do not lower tail_risk_positive gate",
      "do not synthesize hedge intent without fresh quote evidence",
      "do not send live orders from OpenClaw/Codex/Claude/Telegram",
    ],
    safetyLock: {
      paperOnly: true,
      simulatedOnly: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      noLiveOrderSent: true,
    },
    noOrderWrite: true,
    machineLine: `tailRiskPromotionDiagnostic=${status};operatorDecision=do_not_promote;p05=${finiteNumber(strategyFill?.tailRiskRepair?.currentP05Pts) ?? 0};stopHitRate=${stopHitRate ?? "missing"};positiveTailCandidates=${Number(strategyFill?.tailRiskRepair?.positiveTailCandidateCount ?? 0)};nextBatch=${nextBatch.status ?? "missing"};candidateQuality=${candidateQuality.status ?? "missing"};freshRefresh=${repairCandidatePlan?.freshCandidateRefreshPlan?.status ?? "missing"};riskReview=${repairCandidatePlan?.riskNotionalReviewPlan?.status ?? "missing"};noOrderWrite=true`,
  };
}

function buildNextCommand(status, repairCandidatePlan = {}) {
  if (status === "tail_risk_passed") {
    return {
      id: "rerun_paper_promotion_gate",
      command: "pnpm capital:paper-hft:auto-review:check",
      validationCommand: "pnpm capital:paper-hft:auto-review:check",
      followUpCommand: "pnpm capital:paper-hft:auto-review",
      reason: "tail risk passed; rerun the paper promotion gate before any operator review.",
      noOrderWrite: true,
    };
  }
  const riskNotionalReviewPlan = repairCandidatePlan?.riskNotionalReviewPlan ?? {};
  if (
    riskNotionalReviewPlan.status === "requires_paper_risk_resizing_review" &&
    Number(riskNotionalReviewPlan.actionableCandidateCount ?? 0) > 0
  ) {
    return {
      id: "rerun_paper_risk_resized_candidates",
      command: "pnpm capital:strategy:risk-resized-paper-rerun:check",
      validationCommand: "pnpm capital:strategy:risk-resized-paper-rerun:check",
      followUpCommand: "pnpm capital:strategy:tail-risk-repair:check",
      reason:
        "tail risk is still blocked and actionable risk-notional candidates exist; run paper-only risk-resized rerun before refreshing the broad paper candidate pool.",
      requiredEvidence: [
        "paper-only regenerated intent",
        "riskNotional <= maxRiskNotional",
        "p05_total_pnl_pts > 0",
        "p05_total_pnl_notional > 0",
      ],
      noOrderWrite: true,
    };
  }
  return {
    id: "refresh_current_paper_candidates",
    command: "pnpm capital:trade:current-paper-intents",
    validationCommand: "pnpm capital:trade:current-paper-intents:check",
    followUpCommand: "pnpm capital:strategy:fill-simulation:check",
    reason:
      "tail risk is still blocked; refresh fresh resolved paper candidates, then rerun same-case fill simulation.",
    requiredEvidence: [
      "routeStatus=resolved",
      "wallClockFresh=true",
      "known pointValueCurrency",
      "p05_total_pnl_pts > 0",
    ],
    noOrderWrite: true,
  };
}

export function buildCapitalStrategyTailRiskRepairPlan(strategyFill, options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const promotionBlockedReasons = safeArray(strategyFill?.promotionGate?.blockedReasons);
  const tailBlocked =
    promotionBlockedReasons.includes("tail_risk_positive") ||
    strategyFill?.tailRiskRepair?.status === "blocked_no_positive_tail_candidate";
  const diagnostics = selectedDiagnostics(strategyFill);
  const empirical = empiricalEvidence(strategyFill);
  const repairActions = buildRepairActions({ strategyFill, diagnostics, empirical });
  const riskResizedRejectionExclusion = buildRiskResizedRejectionExclusion(
    options.riskResizedRerunReport,
  );
  const repairCandidatePlan = buildRepairCandidatePlan({
    strategyFill,
    empirical,
    riskResizedRejectionExclusion,
  });
  const promotionBlockerDiagnostic = buildPromotionBlockerDiagnostic({
    strategyFill,
    diagnostics,
    empirical,
    repairCandidatePlan,
  });
  const effectiveReadyActions = repairActions.filter((action) =>
    ["ready_for_paper_calibration", "possible_after_signal_strengthens"].includes(action.status),
  );
  const status = !tailBlocked
    ? "tail_risk_passed"
    : effectiveReadyActions.length > 0
      ? "blocked_requires_same_case_rerun"
      : "blocked_no_effective_repair_ready";
  const nextCommand = buildNextCommand(status, repairCandidatePlan);
  const stopHitRate = finiteNumber(empirical?.outcomeStats?.stopHitRate);
  const requiredConfidence = maxRequiredConfidence(diagnostics);
  const conclusion =
    status === "tail_risk_passed"
      ? "tail risk gate 已通過；仍需 promotion/canary/rollback gate。"
      : "tail risk 仍 blocked；不得 promotion，不得真單，只能收集 fresh resolved 候選或實際 paper outcome 證據後重跑。";
  return {
    schema: SCHEMA,
    generatedAt,
    status,
    sourceStrategyFillStatus: strategyFill?.status ?? "",
    sourceRecommendation: strategyFill?.recommendation ?? "",
    promotionGateStatus: strategyFill?.promotionGate?.status ?? "",
    promotionBlockedReasons,
    currentP05Pts: finiteNumber(strategyFill?.tailRiskRepair?.currentP05Pts) ?? 0,
    currentP05Notional: finiteNumber(strategyFill?.tailRiskRepair?.currentP05Notional) ?? 0,
    selectedSymbols: safeArray(strategyFill?.tailRiskRepair?.selectedSymbols),
    selectedDiagnostics: diagnostics.map((diagnostic) => ({
      symbol: diagnostic.symbol,
      intentId: diagnostic.intentId,
      confidence: diagnostic.confidence,
      modeledLossProbability: diagnostic.tailPassFeasibility?.modeledLossProbability ?? null,
      requiredConfidenceForPositiveP05:
        diagnostic.tailPassFeasibility?.requiredConfidenceForPositiveP05 ?? null,
    })),
    empiricalTailEvidence: {
      status: empirical.status ?? "",
      evidenceMode: empirical.evidenceMode ?? "",
      sampleCount: empirical.outcomeStats?.sampleCount ?? 0,
      stopHitRate: empirical.outcomeStats?.stopHitRate ?? null,
      simulatedOnly: empirical.outcomeStats?.simulatedOnly === true,
      liveCalibrationAllowed: empirical.liveCalibrationAllowed === true,
      noLiveOrderSent: empirical.noLiveOrderSent === true,
    },
    repairActions,
    repairCandidatePlan,
    riskResizedRejectionExclusion,
    promotionBlockerDiagnostic,
    nextCommand,
    nextSafeTask:
      status === "tail_risk_passed"
        ? "重跑 paper promotion gate；仍不得送真單。"
        : nextCommand.command === "pnpm capital:strategy:risk-resized-paper-rerun:check"
          ? "先跑 paper-only risk-resized rerun，確認縮風險後 p05 是否轉正；仍不得送真單。"
          : "先收集 fresh resolved 低相關/反向 paper candidate，或等 paper outcome stopHitRate <= 0.05 後重跑 capital:strategy:fill-simulation:check。",
    conclusion,
    safetyLock: {
      paperOnly: true,
      simulatedOnly: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      brokerWriteAttempted: false,
      sentOrder: false,
      noLiveOrderSent: true,
      promotionBlocked: status !== "tail_risk_passed",
    },
    machineLine: `tailRiskRepairPlan=${status};p05=${finiteNumber(strategyFill?.tailRiskRepair?.currentP05Pts) ?? 0};stopHitRate=${stopHitRate ?? "missing"};requiredConfidence=${requiredConfidence ?? "missing"};candidatePlan=${repairCandidatePlan.status};nextPaperCandidateBatch=${repairCandidatePlan.nextPaperCandidateBatch.status};freshCandidateRefresh=${repairCandidatePlan.freshCandidateRefreshPlan.status};riskNotionalReview=${repairCandidatePlan.riskNotionalReviewPlan.status};riskResizedRejection=${riskResizedRejectionExclusion.status};promotionDiagnostic=${promotionBlockerDiagnostic.status};candidateBuckets=${repairCandidatePlan.buckets.map((bucket) => `${bucket.id}:${bucket.status}`).join(",")};nextCommand=${nextCommand.command};validationCommand=${nextCommand.validationCommand};actions=${repairActions.map((action) => `${action.id}:${action.status}`).join(",")};noOrderWrite=true`,
  };
}

export async function writeCapitalStrategyTailRiskRepairPlan({ repoRoot, strategyFill, report }) {
  const root = path.resolve(repoRoot ?? process.cwd());
  const value = qualifyOpenClawPnpmCommands(
    root,
    report ?? buildCapitalStrategyTailRiskRepairPlan(strategyFill),
  );
  const tradingPath = path.join(
    root,
    ".openclaw",
    "trading",
    "capital-strategy-tail-risk-repair.json",
  );
  const reportPath = path.join(
    root,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-strategy-tail-risk-repair-latest.json",
  );
  await writeJsonWithSha(tradingPath, value);
  await writeJsonWithSha(reportPath, value);
  return { ...value, paths: { tradingPath, reportPath } };
}

export async function runCapitalStrategyTailRiskRepair(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const strategyFill =
    options.strategyFill ??
    (await runStrategyFillSimulation({ repoRoot, outputPath: options.strategyFillPath }));
  const riskResizedRerunReportPath =
    options.riskResizedRerunReportPath ??
    path.join(
      repoRoot,
      "reports",
      "hermes-agent",
      "state",
      "openclaw-capital-risk-resized-paper-intent-rerun-gate-latest.json",
    );
  const riskResizedRerunReport =
    options.riskResizedRerunReport ?? (await readJsonIfExists(riskResizedRerunReportPath));
  const report = buildCapitalStrategyTailRiskRepairPlan(strategyFill, {
    riskResizedRerunReport,
  });
  return writeCapitalStrategyTailRiskRepairPlan({ repoRoot, strategyFill, report });
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const result = await runCapitalStrategyTailRiskRepair({
    repoRoot: argValue(args, "--repo-root"),
  });
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `schema: ${result.schema}`,
      `status: ${result.status}`,
      `selected: ${result.selectedSymbols.join(",") || "none"}`,
      `p05: ${result.currentP05Pts}`,
      `next: ${result.nextSafeTask}`,
      `no_live_order_sent: ${result.safetyLock.noLiveOrderSent}`,
    ].join("\n") + "\n",
  );
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
