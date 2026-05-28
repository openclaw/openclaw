#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCapitalDirectStrategyPlatformGate } from "./openclaw-capital-direct-strategy-platform-gate.mjs";
import {
  buildFreshCandidateSameCaseRerunGate,
  writeFreshCandidateSameCaseRerunGate,
} from "./openclaw-capital-fresh-candidate-same-case-rerun-gate.mjs";
import { runCapitalFreshPaperCandidateCollector } from "./openclaw-capital-fresh-paper-candidate-collector.mjs";
import {
  buildOppositeExposurePaperRerunGate,
  writeOppositeExposurePaperRerunGate,
} from "./openclaw-capital-opposite-exposure-paper-rerun-gate.mjs";
import { runCapitalPaperAutoReview } from "./openclaw-capital-paper-auto-review.mjs";
import { runStrategyEngine } from "./openclaw-capital-strategy-engine.mjs";

const SCHEMA = "openclaw.capital.trade-auto-cycle.v1";

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    writeState: argv.includes("--write-state"),
    symbol: valueAfter(argv, "--symbol") ?? "tx-front",
  };
}

function valueAfter(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeJsonWithSha(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

function safetyOk(platformGate, autoReview) {
  return (
    platformGate?.safety?.paperOnly === true &&
    platformGate?.safety?.noLiveOrderSent === true &&
    platformGate?.safety?.sentOrder === false &&
    platformGate?.safety?.writeBrokerOrders === false &&
    platformGate?.execution?.liveWriteAllowed === false &&
    platformGate?.execution?.sentOrder === false &&
    autoReview?.liveTradingEnabled === false &&
    autoReview?.writeTradingEnabled === false &&
    autoReview?.brokerOrderPathEnabled === false
  );
}

function firstBlockedStage(platformGate) {
  return (
    platformGate?.liveCompletion?.stages?.find((stage) => stage?.status === "blocked")?.id ?? ""
  );
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function failedReplayQuoteDigestGateFromCollector(collector) {
  return collector?.selectedReference?.failedReplayQuoteDigestGate ?? {};
}

function promotionGroupById(diagnostics, id) {
  return asArray(diagnostics?.groups).find((group) => group?.id === id) ?? {};
}

function includesAny(values, fragments) {
  return values.some((value) =>
    fragments.some((fragment) => String(value ?? "").includes(fragment)),
  );
}

function blockerGroup(id, status, blocking, evidence, nextAction) {
  return {
    id,
    status: status || "unknown",
    blocking: Boolean(blocking),
    evidence,
    nextAction,
  };
}

function buildPromotionBlockerDiagnostics(platformGate, autoReview) {
  const blockers = asArray(platformGate?.blockers);
  const strategyFill = platformGate?.strategy?.strategyFill ?? {};
  const evaluator = platformGate?.strategy?.evaluator ?? {};
  const paperOutcome = platformGate?.strategy?.paperOutcomeLedger?.stats ?? {};
  const tailRiskRepair =
    platformGate?.strategy?.strategyTailRiskRepair ?? strategyFill?.tailRiskRepair ?? {};
  const quote = platformGate?.quote ?? {};
  const a50 = quote?.a50 ?? {};
  const multiTarget = quote?.multiTarget ?? {};
  const execution = platformGate?.execution ?? {};
  const activeTargets = execution?.activeTargets ?? {};
  const adapterAck = activeTargets?.externalBrokerAdapterAck ?? {};
  const verifiedPosition = activeTargets?.verifiedPositionSnapshot ?? {};
  const strategyBlocking =
    strategyFill?.promotionGate?.status !== "pass" ||
    evaluator?.recommendation === "reject" ||
    strategyFill?.recommendation === "hold" ||
    includesAny(blockers, ["strategy_fill", "strategy_evaluator", "evaluator:", "risk:"]);
  const quoteBlocking =
    a50?.status === "stale" ||
    includesAny(blockers, ["quote:a50_stale", "a50_not_wall_clock_fresh"]);
  const adapterBlocking =
    execution.externalBrokerAdapterAckStatus !== "acknowledged" ||
    adapterAck.hashOk !== true ||
    includesAny(blockers, ["adapter:ack"]);
  const positionBlocking =
    verifiedPosition.freshnessStatus === "stale" ||
    includesAny(blockers, ["position:verified-fresh"]);
  const liveBlocking = includesAny(blockers, ["live:", "LIVE_TRADING_", "live-risk:"]);
  const groups = [
    blockerGroup(
      "strategy_fill_gate",
      strategyFill?.promotionGate?.status ?? strategyFill?.recommendation,
      strategyBlocking,
      {
        recommendation: strategyFill?.recommendation ?? "",
        promotionGate: strategyFill?.promotionGate?.status ?? "",
        expectedValuePts: strategyFill?.stats?.expected_value_pts ?? null,
        p05Pts: strategyFill?.monteCarlo?.p05_total_pnl_pts ?? null,
        stopHitRate: paperOutcome?.stopHitRate ?? null,
        evaluatorRecommendation: evaluator?.recommendation ?? "",
        evaluatorPassCount: evaluator?.passCount ?? 0,
        evaluatorRuleCount: evaluator?.ruleCount ?? 0,
        tailRiskRepairStatus: tailRiskRepair?.status ?? "",
        autoReviewStatus: autoReview?.status ?? "",
      },
      "collect_fresh_low_correlation_or_opposite_paper_candidates_then_rerun_capital_strategy_fill_simulation_check",
    ),
    blockerGroup(
      "quote_freshness",
      quote?.overallFreshness ?? a50?.status,
      quoteBlocking,
      {
        overallFreshness: quote?.overallFreshness ?? "",
        a50Status: a50?.status ?? "",
        a50Subscribed: a50?.subscribed === true,
        a50AgeSeconds: a50?.ageSeconds ?? null,
        multiTargetStatus: multiTarget?.status ?? "",
        freshPaperTargetCount: multiTarget?.freshPaperTargetCount ?? 0,
      },
      "wait_for_brokerdesk_a50_fresh_event_or_rerun_capital_hft_auto_trading_tick_diagnostic",
    ),
    blockerGroup(
      "adapter_ack",
      execution.externalBrokerAdapterAckStatus,
      adapterBlocking,
      {
        ackStatus: execution.externalBrokerAdapterAckStatus ?? "",
        hashOk: adapterAck.hashOk === true,
        expectedSealedIntentSha256: adapterAck.expectedSealedIntentSha256 ?? "",
        actualSealedIntentSha256: adapterAck.actualSealedIntentSha256 ?? "",
      },
      "operator_refresh_external_broker_adapter_ack_for_current_sealed_intent_sha256",
    ),
    blockerGroup(
      "verified_position_snapshot",
      verifiedPosition.freshnessStatus ?? execution.positionDecision?.status,
      positionBlocking,
      {
        positionDecisionStatus: execution.positionDecision?.status ?? "",
        verifiedSnapshotStatus: verifiedPosition.status ?? "",
        freshnessStatus: verifiedPosition.freshnessStatus ?? "",
        verifiedAgeSeconds: verifiedPosition.verifiedAgeSeconds ?? null,
        maxFreshSeconds: verifiedPosition.maxFreshSeconds ?? null,
      },
      "operator_refresh_verified_position_snapshot_then_rerun_capital_trade_direct_status_check",
    ),
    blockerGroup(
      "live_promotion_safety",
      platformGate?.status,
      liveBlocking,
      {
        liveTradingEnabled: false,
        brokerWriteAttempted: false,
        sentOrder: false,
        liveBlockerCount: blockers.filter((blocker) =>
          /live|LIVE_TRADING/.test(String(blocker ?? "")),
        ).length,
      },
      "keep_live_blocked_until_all_paper_promotion_canary_and_rollback_gates_pass",
    ),
  ];
  const firstBlocking = groups.find((group) => group.blocking);
  const machineLine = [
    `promotionBlockers=${groups
      .map((group) => `${group.id}:${group.blocking ? "blocked" : "pass"}`)
      .join("/")}`,
    `first=${firstBlocking?.id ?? "none"}`,
    `next=${firstBlocking?.nextAction ?? "none"}`,
    "noLiveOrderSent=true",
  ].join(" ");
  return {
    status: firstBlocking ? `blocked_${firstBlocking.id}` : "pass",
    firstBlocking: firstBlocking?.id ?? "",
    nextAction: firstBlocking?.nextAction ?? "",
    groups,
    machineLine,
    noLiveOrderSent: true,
  };
}

function buildReport({
  repoRoot,
  symbol,
  strategyEngine,
  platformGate,
  autoReview,
  freshPaperCandidateCollector,
  freshCandidateSameCaseRerun,
  oppositeExposurePaperRerun,
}) {
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const reportPath = path.join(stateRoot, "openclaw-capital-trade-auto-cycle-latest.json");
  const panelPath = path.join(tradingRoot, "capital-trade-auto-cycle.json");
  const safe = safetyOk(platformGate, autoReview);
  const operatorCanExecute = platformGate?.execution?.operatorCanExecute === true;
  const noLiveOrderSent = platformGate?.execution?.noLiveOrderSent === true;
  const decisionStatus = operatorCanExecute
    ? "operator_external_adapter_may_review"
    : "blocked_do_not_send";
  const blockedAt = firstBlockedStage(platformGate);
  const nextSafeTask =
    platformGate?.nextSafeTask ??
    autoReview?.tuningPlan?.actions?.[0]?.action ??
    "rerun capital:trade:auto-cycle after the next fresh quote digest";
  const promotionBlockerDiagnostics = buildPromotionBlockerDiagnostics(platformGate, autoReview);
  const adapterAckBlocker = promotionGroupById(promotionBlockerDiagnostics, "adapter_ack");
  const adapterAckEvidence = adapterAckBlocker?.evidence ?? {};
  const verifiedPositionBlocker = promotionGroupById(
    promotionBlockerDiagnostics,
    "verified_position_snapshot",
  );
  const verifiedPositionEvidence = verifiedPositionBlocker?.evidence ?? {};
  const failedReplayQuoteDigestGate = failedReplayQuoteDigestGateFromCollector(
    freshPaperCandidateCollector,
  );
  const failedReplayQuoteDigestActiveSymbols = asArray(
    failedReplayQuoteDigestGate?.activeExcludedSymbols,
  );
  const failedReplayQuoteDigestUnlockedSymbols = asArray(
    failedReplayQuoteDigestGate?.staleUnlockedSymbols,
  );

  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    repoRoot,
    status: platformGate?.status ?? "unknown",
    mode: "single_command_paper_strategy_cycle",
    requestedSymbol: symbol,
    steps: [
      {
        id: "strategy_engine",
        command: `pnpm capital:strategy:engine -- --symbol ${symbol}`,
        status: strategyEngine?.status ?? "unknown",
        intentsWritten: strategyEngine?.stats?.intentsWritten ?? 0,
        noLiveOrderSent: true,
      },
      {
        id: "current_paper_intents_to_platform_gate",
        command: "pnpm capital:trade:platform:check",
        status: platformGate?.strategy?.currentPaperIntents?.status ?? "unknown",
        activeIntents: platformGate?.strategy?.currentPaperIntents?.activeIntentsRecordCount ?? 0,
        noLiveOrderSent: platformGate?.safety?.noLiveOrderSent === true,
      },
      {
        id: "strategy_fill_tail_risk",
        command: "pnpm capital:strategy:tail-risk-repair:check",
        status: platformGate?.strategy?.strategyTailRiskRepair?.status ?? "unknown",
        p05: platformGate?.strategy?.strategyFill?.tailRiskRepair?.currentP05Pts ?? null,
        noLiveOrderSent:
          platformGate?.strategy?.strategyTailRiskRepair?.safetyLock?.noLiveOrderSent === true,
      },
      {
        id: "paper_evaluator",
        command: "pnpm capital:paper-hft:evaluate",
        status: platformGate?.strategy?.evaluator?.recommendation ?? "unknown",
        passCount: platformGate?.strategy?.evaluator?.passCount ?? 0,
        ruleCount: platformGate?.strategy?.evaluator?.ruleCount ?? 0,
        noLiveOrderSent: platformGate?.strategy?.evaluator?.safetyLock?.writeBrokerOrders === false,
      },
      {
        id: "paper_auto_review",
        command: "pnpm capital:paper-hft:auto-review:check",
        status: autoReview?.status ?? "unknown",
        promoted: autoReview?.promoted === true,
        noLiveOrderSent: autoReview?.safetyChecks?.liveStillBlocked === true,
      },
      {
        id: "fresh_paper_candidate_collector",
        command: "pnpm capital:strategy:fresh-paper-candidates:check",
        status: freshPaperCandidateCollector?.status ?? "unknown",
        selectedCandidateCount: freshPaperCandidateCollector?.counts?.selectedCandidateCount ?? 0,
        crossGroupCandidateCount:
          freshPaperCandidateCollector?.counts?.crossGroupCandidateCount ?? 0,
        oppositeCandidateCount: freshPaperCandidateCollector?.counts?.oppositeCandidateCount ?? 0,
        failedReplayQuoteDigestGateStatus: failedReplayQuoteDigestGate?.status ?? "unknown",
        failedReplayQuoteDigestActiveSymbols,
        failedReplayQuoteDigestUnlockedSymbols,
        noLiveOrderSent: freshPaperCandidateCollector?.safetyLock?.noLiveOrderSent === true,
      },
      {
        id: "fresh_candidate_same_case_rerun",
        command: "pnpm capital:strategy:fresh-candidate-same-case-rerun:check",
        status: freshCandidateSameCaseRerun?.status ?? "unknown",
        rerunIntentCount: freshCandidateSameCaseRerun?.rerunIntentCount ?? 0,
        passCount: freshCandidateSameCaseRerun?.passCount ?? 0,
        p05TotalPnlPts: freshCandidateSameCaseRerun?.rerun?.p05TotalPnlPts ?? null,
        noLiveOrderSent: freshCandidateSameCaseRerun?.safetyLock?.noLiveOrderSent === true,
      },
      {
        id: "opposite_exposure_paper_rerun",
        command: "pnpm capital:strategy:opposite-exposure-paper-rerun:check",
        status: oppositeExposurePaperRerun?.status ?? "unknown",
        rerunIntentCount: oppositeExposurePaperRerun?.rerunIntentCount ?? 0,
        passCount: oppositeExposurePaperRerun?.passCount ?? 0,
        p05TotalPnlPts: oppositeExposurePaperRerun?.rerun?.p05TotalPnlPts ?? null,
        noLiveOrderSent: oppositeExposurePaperRerun?.safetyLock?.noLiveOrderSent === true,
      },
    ],
    summary: {
      sealedOrderIntentSha256: platformGate?.execution?.sealedOrderIntentSha256 ?? "",
      quoteFreshness: platformGate?.quote?.overallFreshness ?? "",
      a50Status: platformGate?.liveCompletion?.stages?.[0]?.evidence?.a50Status ?? "",
      positionDecisionStatus: platformGate?.execution?.positionDecision?.status ?? "",
      externalBrokerAdapterAckStatus: platformGate?.execution?.externalBrokerAdapterAckStatus ?? "",
      strategyFillGate: platformGate?.strategy?.strategyFill?.promotionGate?.status ?? "",
      evaluatorRecommendation: platformGate?.strategy?.evaluator?.recommendation ?? "",
      operatorCanExecute,
      dispatchPolicy: platformGate?.execution?.dispatchPolicy ?? "",
      noLiveOrderSent,
      blockedAt,
      promotionBlockerStatus: promotionBlockerDiagnostics.status,
      promotionBlockerFirst: promotionBlockerDiagnostics.firstBlocking,
      promotionBlockerNextAction: promotionBlockerDiagnostics.nextAction,
      adapterAckBlockerStatus: adapterAckBlocker?.status ?? "unknown",
      adapterAckBlockerBlocking: adapterAckBlocker?.blocking === true,
      adapterAckBlockerNextAction: adapterAckBlocker?.nextAction ?? "",
      adapterAckHashOk: adapterAckEvidence?.hashOk === true,
      adapterAckExpectedSealedIntentSha256: adapterAckEvidence?.expectedSealedIntentSha256 ?? "",
      adapterAckActualSealedIntentSha256: adapterAckEvidence?.actualSealedIntentSha256 ?? "",
      adapterAckBlockerMachineLine: `adapterAckBlocker=${
        adapterAckBlocker?.status ?? "unknown"
      };blocking=${adapterAckBlocker?.blocking === true};hashOk=${
        adapterAckEvidence?.hashOk === true
      };expected=${adapterAckEvidence?.expectedSealedIntentSha256 ?? "missing"};actual=${
        adapterAckEvidence?.actualSealedIntentSha256 ?? "missing"
      };next=${adapterAckBlocker?.nextAction ?? "none"};noOrderWrite=true`,
      verifiedPositionBlockerStatus: verifiedPositionBlocker?.status ?? "unknown",
      verifiedPositionBlockerBlocking: verifiedPositionBlocker?.blocking === true,
      verifiedPositionBlockerNextAction: verifiedPositionBlocker?.nextAction ?? "",
      verifiedPositionSnapshotStatus: verifiedPositionEvidence?.verifiedSnapshotStatus ?? "",
      verifiedPositionFreshnessStatus: verifiedPositionEvidence?.freshnessStatus ?? "",
      verifiedPositionAgeSeconds: verifiedPositionEvidence?.verifiedAgeSeconds ?? null,
      verifiedPositionMaxFreshSeconds: verifiedPositionEvidence?.maxFreshSeconds ?? null,
      verifiedPositionBlockerMachineLine: `verifiedPositionBlocker=${
        verifiedPositionBlocker?.status ?? "unknown"
      };blocking=${verifiedPositionBlocker?.blocking === true};snapshot=${
        verifiedPositionEvidence?.verifiedSnapshotStatus ?? "missing"
      };freshness=${verifiedPositionEvidence?.freshnessStatus ?? "missing"};age=${
        verifiedPositionEvidence?.verifiedAgeSeconds ?? "missing"
      };maxFresh=${verifiedPositionEvidence?.maxFreshSeconds ?? "missing"};next=${
        verifiedPositionBlocker?.nextAction ?? "none"
      };noOrderWrite=true`,
      freshPaperCandidateCollectorStatus: freshPaperCandidateCollector?.status ?? "unknown",
      freshPaperCandidateCount: freshPaperCandidateCollector?.counts?.selectedCandidateCount ?? 0,
      failedReplayQuoteDigestGateStatus: failedReplayQuoteDigestGate?.status ?? "unknown",
      failedReplayQuoteDigestActiveSymbols,
      failedReplayQuoteDigestUnlockedSymbols,
      failedReplayQuoteDigestMachineLine: failedReplayQuoteDigestGate?.machineLine ?? "",
      failedReplayQuoteDigestActiveCount: failedReplayQuoteDigestActiveSymbols.length,
      failedReplayQuoteDigestUnlockedCount: failedReplayQuoteDigestUnlockedSymbols.length,
      freshCandidateSameCaseRerunStatus: freshCandidateSameCaseRerun?.status ?? "unknown",
      freshCandidateSameCaseRerunPassCount: freshCandidateSameCaseRerun?.passCount ?? 0,
      freshCandidateSameCaseRerunP05Pts: freshCandidateSameCaseRerun?.rerun?.p05TotalPnlPts ?? null,
      oppositeExposurePaperRerunStatus: oppositeExposurePaperRerun?.status ?? "unknown",
      oppositeExposurePaperRerunPassCount: oppositeExposurePaperRerun?.passCount ?? 0,
      oppositeExposurePaperRerunP05Pts: oppositeExposurePaperRerun?.rerun?.p05TotalPnlPts ?? null,
    },
    promotionBlockerDiagnostics,
    decision: {
      status: decisionStatus,
      canTradeInsideOpenClaw: false,
      operatorCanExecute,
      noLiveOrderSent,
      reason: operatorCanExecute
        ? "All OpenClaw gates only reached external operator review; OpenClaw still does not send broker orders."
        : `Blocked at ${blockedAt || platformGate?.status || "unknown"}.`,
    },
    safety: {
      paperOnly: true,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      brokerWriteAttempted: false,
      sentOrder: false,
      noLiveOrderSent: true,
      codexBrokerWriteAllowed: false,
      claudeBrokerWriteAllowed: false,
      openclawBrokerWriteAllowed: false,
      telegramBrokerWriteAllowed: false,
      safetyOk: safe,
    },
    blockers: platformGate?.blockers ?? [],
    nextSafeTask,
    sourceReports: {
      strategyEngine: strategyEngine?.paths?.reportPath ?? "",
      platformGate: platformGate?.paths?.reportPath ?? "",
      paperAutoReview: autoReview?.reportPath ?? "",
      freshPaperCandidateCollector: freshPaperCandidateCollector?.paths?.reportPath ?? "",
      freshCandidateSameCaseRerun: freshCandidateSameCaseRerun?.paths?.reportPath ?? "",
      oppositeExposurePaperRerun: oppositeExposurePaperRerun?.paths?.reportPath ?? "",
    },
    paths: {
      reportPath,
      panelPath,
    },
  };
}

export async function runCapitalTradeAutoCycle(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const symbol = options.symbol ?? "tx-front";
  const strategyEngine = await runStrategyEngine({ repoRoot, symbol });
  const platformGate = await buildCapitalDirectStrategyPlatformGate({ repoRoot });
  await writeJsonWithSha(platformGate.paths.reportPath, platformGate);
  await writeJsonWithSha(platformGate.paths.panelPath, platformGate);
  const autoReview = await runCapitalPaperAutoReview({ repoRoot, writeState: true });
  const freshPaperCandidateCollector = await runCapitalFreshPaperCandidateCollector({
    repoRoot,
    writeState: true,
  });
  const freshCandidateSameCaseRerun = await buildFreshCandidateSameCaseRerunGate({
    repoRoot,
    collectorReport: freshPaperCandidateCollector,
  });
  await writeFreshCandidateSameCaseRerunGate(freshCandidateSameCaseRerun);
  const oppositeExposurePaperRerun = await buildOppositeExposurePaperRerunGate({
    repoRoot,
    collectorReport: freshPaperCandidateCollector,
  });
  await writeOppositeExposurePaperRerunGate(oppositeExposurePaperRerun);
  const report = buildReport({
    repoRoot,
    symbol,
    strategyEngine,
    platformGate,
    autoReview,
    freshPaperCandidateCollector,
    freshCandidateSameCaseRerun,
    oppositeExposurePaperRerun,
  });
  if (options.writeState === true) {
    await writeJsonWithSha(report.paths.reportPath, report);
    await writeJsonWithSha(report.paths.panelPath, report);
  }
  if (!report.safety.safetyOk) {
    throw new Error("CAPITAL_TRADE_AUTO_CYCLE_SAFETY_MISMATCH");
  }
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runCapitalTradeAutoCycle({
    repoRoot: process.cwd(),
    symbol: options.symbol,
    writeState: options.writeState,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `CAPITAL_TRADE_AUTO_CYCLE=${report.status} decision=${report.decision.status} quote=${report.summary.quoteFreshness} strategyFillGate=${report.summary.strategyFillGate} operatorCanExecute=${report.summary.operatorCanExecute} noLiveOrderSent=${report.summary.noLiveOrderSent}\n`,
  );
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
