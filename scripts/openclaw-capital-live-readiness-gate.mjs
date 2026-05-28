#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCapitalDirectStrategyPlatformGate } from "./openclaw-capital-direct-strategy-platform-gate.mjs";
import { buildCapitalExternalBrokerAdapterAckGate } from "./openclaw-capital-external-broker-adapter-ack-gate.mjs";
import { buildCapitalLiveExecutorArmProfile } from "./openclaw-capital-live-executor-arm-profile.mjs";
import { buildCapitalLiveOrderDryRunPretradeGate } from "./openclaw-capital-live-order-dry-run-pretrade-gate.mjs";
import { runCapitalLiveTradingOperatorGate } from "./openclaw-capital-live-trading-operator-gate.mjs";
import { runCapitalLiveTradingPromotionGate } from "./openclaw-capital-live-trading-promotion-gate.mjs";

const SCHEMA = "openclaw.capital.live-readiness-gate.v1";
const currentFile = fileURLToPath(import.meta.url);
const DIRECT_PRETRADE_SAFETY_ONLY_BLOCKERS = new Set([
  "agent-broker-write-disabled",
  "live-broker-write-is-enabled",
]);

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

async function writeJsonWithSha(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

function statusOf(ok) {
  return ok ? "pass" : "fail";
}

function buildCheck(id, ok, message, evidence = {}) {
  return {
    id,
    status: statusOf(ok),
    message,
    evidence,
  };
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function unwrapReport(value) {
  return value?.report && typeof value.report === "object" ? value.report : (value ?? {});
}

function sourceReport(result) {
  if (result?.ok === true) {
    return unwrapReport(result.value);
  }
  return {};
}

function sourceError(result) {
  if (result?.ok === true) {
    return "";
  }
  return result?.error || "source unavailable";
}

function hasStrategyBlocker(blockers) {
  return blockers.some((blocker) =>
    /^strategy_|^strategy:|^strategy_fill|^tail_risk|^evaluator|^paper_outcome_ledger/.test(
      String(blocker),
    ),
  );
}

function renderMarkdown(report) {
  return [
    "# OpenClaw Capital Live Readiness Gate",
    "",
    `- status: ${report.status}`,
    `- sealedOrderIntent.sha256: ${report.sealedOrderIntentSha256 || "missing"}`,
    `- positionDecision.status: ${report.readiness.positionDecision.status || "missing"}`,
    `- externalBrokerAdapter.ack.status: ${report.readiness.externalBrokerAdapter.ackStatus || "missing"}`,
    `- adapterAckGate.status: ${report.readiness.externalBrokerAdapter.ackGateStatus || "missing"}`,
    `- adapterAckGate.hashOk: ${report.readiness.externalBrokerAdapter.hashOk}`,
    `- adapterAckGate.refreshPlan: ${report.readiness.externalBrokerAdapter.refreshPlan?.status || "missing"}`,
    `- adapterAckGate.safeToPromoteCandidate: ${report.readiness.externalBrokerAdapter.refreshPlan?.safeToPromoteCandidate === true}`,
    `- adapterAckGate.candidateRollbackVerifiedAt: ${report.readiness.externalBrokerAdapter.refreshPlan?.candidateRollbackVerifiedAt || "missing"}`,
    `- quote freshness: ${report.readiness.quote.overallFreshness || "missing"}`,
    `- no_live_order_sent: ${report.safety.no_live_order_sent}`,
    `- sentOrder: ${report.safety.sentOrder}`,
    `- machineLine: ${report.machineLine}`,
    "",
    "## Remaining blockers",
    ...report.remainingBlockers.map((blocker) => `- ${blocker}`),
    "",
    `nextSafeTask: ${report.nextSafeTask}`,
    "",
  ].join("\n");
}

async function captureGate(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildCapitalLiveReadinessReport(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const platform = unwrapReport(options.platform);
  const direct = unwrapReport(options.direct);
  const adapterAckGate = unwrapReport(options.adapterAckGate);
  const promotion = unwrapReport(options.promotion);
  const operator = unwrapReport(options.operator);
  const armProfile = unwrapReport(options.armProfile);
  const sourceStatus = options.sourceStatus ?? {};
  const platformBlockers = safeArray(platform.blockers);
  const directBlockers = safeArray(direct.preTradeRiskGate?.blockers);
  const promotionBlockers = safeArray(promotion.blockers).filter(
    (blocker) =>
      !(
        promotion.readyForManualReview === true && blocker === "LIVE_TRADING_MANUAL_REVIEW_REQUIRED"
      ),
  );
  const adapterAckGateBlockers = safeArray(adapterAckGate.blockers);
  const operatorBlockers = safeArray(operator.blockers);
  const armProfileBlockers = safeArray(armProfile.blockers);
  const upstreamBlockers = [
    ...platformBlockers.map((blocker) => `platform:${blocker}`),
    ...directBlockers.map((blocker) => `direct:${blocker}`),
    ...adapterAckGateBlockers.map((blocker) => `adapterAckGate:${blocker}`),
    ...promotionBlockers.map((blocker) => `promotion:${blocker}`),
    ...operatorBlockers.map((blocker) => `operator:${blocker}`),
    ...armProfileBlockers.map((blocker) => `armProfile:${blocker}`),
  ];

  const quoteReady =
    platform.quote?.strategyQuoteReady === true &&
    ["a50_fresh", "multi_target_fresh"].includes(platform.quote?.overallFreshness);
  const strategyReady =
    platform.strategy?.strategyFill?.recommendation === "promote" ||
    platform.strategy?.strategyFill?.promotionGate?.paperPromotionEligible === true ||
    (platform.status === "blocked_live_promotion_required" &&
      !hasStrategyBlocker(platformBlockers));
  const directPretradeCoreBlockers = directBlockers.filter(
    (blocker) => !DIRECT_PRETRADE_SAFETY_ONLY_BLOCKERS.has(String(blocker)),
  );
  const directPretradeAllowed =
    direct.safety?.sentOrder === false &&
    (direct.preTradeRiskGate?.allowedToSend === true ||
      (direct.preTradeRiskGate?.attachedBeforeBrokerSend === true &&
        direct.preTradeRiskGate?.evaluated === true &&
        direct.preTradeRiskGate?.allowedToSend === false &&
        directPretradeCoreBlockers.length === 0));
  const positionUsable =
    platform.positionDecision?.usable === true ||
    direct.operatorHandoff?.positionSnapshot?.usable === true;
  const positionStatus =
    platform.execution?.positionDecision?.status ||
    direct.operatorHandoff?.positionDecision?.status ||
    platform.positionDecision?.decisionStatus ||
    "";
  const ack =
    platform.externalBrokerAdapter?.ack ?? direct.operatorHandoff?.externalBrokerAdapter?.ack ?? {};
  const adapterAckGatePresent =
    adapterAckGate.schema === "openclaw.capital.external-broker-adapter-ack-gate.v1";
  const adapterAckGateVerified = !adapterAckGatePresent || adapterAckGate.status === "verified";
  const ackUsable = ack.usable === true && adapterAckGateVerified;
  const adapterAckRefreshPlan = adapterAckGate.operatorReview?.refreshPlan ?? {};
  const ackStatus =
    adapterAckGatePresent && adapterAckGate.status !== "verified"
      ? "blocked"
      : ack.status || (ack.usable === true ? "verified" : "blocked");
  const promotionReady = promotion.readyForManualReview === true;
  const operatorLiveEnabled =
    ["activated", "live_enabled"].includes(operator.status) &&
    operator.riskControls?.enabledAfter === true &&
    operator.riskControls?.allowLiveTrading === true &&
    operator.riskControls?.writeBrokerOrders === true &&
    operator.safety?.sentOrder !== true;
  const liveExecutorArmed =
    armProfile.status === "armed" &&
    armProfile.allowBrokerWriteWhenAllGatesPass === true &&
    armProfile.safety?.sentOrder !== true &&
    armProfile.safety?.brokerWriteAttempted !== true;
  const noLiveOrderSent =
    platform.safety?.sentOrder !== true &&
    direct.safety?.sentOrder !== true &&
    operator.safety?.sentOrder !== true &&
    armProfile.safety?.sentOrder !== true &&
    platform.safety?.noLiveOrderSent !== false &&
    direct.safety?.noLiveOrderSent !== false &&
    armProfile.safety?.noLiveOrderSent !== false;
  const readinessGateNoBrokerWrite = true;
  const sealedOrderIntentSha256 =
    platform.execution?.sealedOrderIntentSha256 ||
    direct.operatorHandoff?.handoffPacket?.sealedOrderIntent?.sha256 ||
    direct.operatorHandoff?.externalBrokerAdapter?.ack?.requiredSealedIntentSha256 ||
    ack.requiredSealedIntentSha256 ||
    "";

  const sourceChecks = [
    buildCheck("source:platform", sourceStatus.platform?.ok !== false, "Read platform gate.", {
      status: platform.status || "",
      error: sourceStatus.platform?.error || "",
    }),
    buildCheck(
      "source:direct-pretrade",
      sourceStatus.direct?.ok !== false,
      "Read direct pretrade gate.",
      {
        status: direct.status || "",
        error: sourceStatus.direct?.error || "",
      },
    ),
    buildCheck(
      "source:adapter-ack",
      sourceStatus.adapterAck?.ok !== false,
      "Read external broker adapter ack gate.",
      {
        status: adapterAckGate.status || "",
        hashOk: adapterAckGate.ack?.hashOk === true,
        error: sourceStatus.adapterAck?.error || "",
      },
    ),
    buildCheck("source:promotion", sourceStatus.promotion?.ok !== false, "Read promotion gate.", {
      status: promotion.status || "",
      error: sourceStatus.promotion?.error || "",
    }),
    buildCheck(
      "source:operator-status",
      sourceStatus.operator?.ok !== false,
      "Read operator status gate.",
      {
        status: operator.status || "",
        error: sourceStatus.operator?.error || "",
      },
    ),
    buildCheck(
      "source:arm-profile",
      sourceStatus.armProfile?.ok !== false,
      "Read local live executor arm profile.",
      {
        status: armProfile.status || "",
        error: sourceStatus.armProfile?.error || "",
      },
    ),
  ];

  const readinessChecks = [
    buildCheck(
      "quote:strategy-fresh",
      quoteReady,
      "A50 or multi-target quote must be fresh for strategy use.",
      {
        overallFreshness: platform.quote?.overallFreshness || "",
        strategyQuoteReady: platform.quote?.strategyQuoteReady === true,
        a50Status: platform.quote?.a50?.status || "",
        multiTargetFreshCount: platform.quote?.multiTarget?.freshPaperTargetCount ?? 0,
      },
    ),
    buildCheck(
      "strategy:paper-promoted",
      strategyReady,
      "Paper strategy must be promotable before live review.",
      {
        platformStatus: platform.status || "",
        strategyFillRecommendation: platform.strategy?.strategyFill?.recommendation || "",
        strategyFillGate: platform.strategy?.strategyFill?.promotionGate?.status || "",
        tailRiskRepairStatus: platform.strategy?.strategyTailRiskRepair?.status || "",
      },
    ),
    buildCheck(
      "direct:pretrade-allowed",
      directPretradeAllowed,
      "Direct pretrade gate must allow dispatch and still send no order.",
      {
        directStatus: direct.status || "",
        allowedToSend: direct.preTradeRiskGate?.allowedToSend === true,
        effectiveAllowed: directPretradeAllowed,
        coreBlockers: directPretradeCoreBlockers,
        sentOrder: direct.safety?.sentOrder === true,
      },
    ),
    buildCheck(
      "position:verified-snapshot",
      positionUsable,
      "Verified position snapshot must be usable.",
      {
        positionStatus,
        usable: positionUsable,
        netContracts:
          platform.positionDecision?.netContracts ??
          direct.operatorHandoff?.positionSnapshot?.netContracts ??
          null,
      },
    ),
    buildCheck(
      "adapter:ack-usable",
      ackUsable,
      "External operator-owned broker adapter ack must match the sealed intent.",
      {
        status: ackStatus,
        usable: ackUsable,
        path: ack.path || "",
        requiredSealedIntentSha256: ack.requiredSealedIntentSha256 || "",
        ackGateStatus: adapterAckGate.status || "",
        ackGateMachineLine: adapterAckGate.machineLine || "",
        hashOk: adapterAckGate.ack?.hashOk === true,
        canaryPass: adapterAckGate.ack?.canaryPass === true,
        rollbackPass: adapterAckGate.ack?.rollbackPass === true,
        requiredTemplatePath: adapterAckGate.ack?.requiredTemplatePath || "",
        refreshPlanStatus: adapterAckRefreshPlan.status || "",
        refreshPlanSafeToPromoteCandidate: adapterAckRefreshPlan.safeToPromoteCandidate === true,
        refreshPlanSourcePath: adapterAckRefreshPlan.sourcePath || "",
        refreshPlanDestinationPath: adapterAckRefreshPlan.destinationPath || "",
        refreshPlanCandidateRollbackVerifiedAt:
          adapterAckRefreshPlan.candidateRollbackVerifiedAt || "",
      },
    ),
    buildCheck(
      "promotion:manual-review-ready",
      promotionReady,
      "Live promotion gate must be ready for manual review.",
      {
        status: promotion.status || "",
        readyForManualReview: promotion.readyForManualReview === true,
        blockerCode: promotion.blockerCode || "",
      },
    ),
    buildCheck(
      "operator:live-enabled",
      operatorLiveEnabled,
      "Operator runtime must be explicitly live-enabled before adapter review.",
      {
        status: operator.status || "",
        enabledAfter: operator.riskControls?.enabledAfter === true,
        allowLiveTrading: operator.riskControls?.allowLiveTrading === true,
        writeBrokerOrders: operator.riskControls?.writeBrokerOrders === true,
      },
    ),
    buildCheck(
      "executor:arm-profile-armed",
      liveExecutorArmed,
      "Local broker executor must be explicitly armed before operator packet can execute.",
      {
        status: armProfile.status || "",
        armed: armProfile.armed === true,
        allowExecutorWrite: armProfile.allowBrokerWriteWhenAllGatesPass === true,
        expiresAt: armProfile.expiresAt || "",
        profilePath: armProfile.paths?.profilePath || "",
      },
    ),
    buildCheck(
      "safety:no-live-order-sent",
      noLiveOrderSent,
      "No checked source may have sent a live order.",
      {
        platformSentOrder: platform.safety?.sentOrder === true,
        directSentOrder: direct.safety?.sentOrder === true,
        operatorSentOrder: operator.safety?.sentOrder === true,
        armProfileSentOrder: armProfile.safety?.sentOrder === true,
      },
    ),
    buildCheck(
      "safety:readiness-gate-no-broker-write",
      readinessGateNoBrokerWrite,
      "This readiness gate is read-only and never writes broker orders.",
      {
        writeBrokerOrders: false,
        readOnlyPreflightOnly: true,
      },
    ),
  ];

  const checks = [...sourceChecks, ...readinessChecks];
  const failedChecks = checks.filter((item) => item.status !== "pass").map((item) => item.id);
  const blockers = [...failedChecks];
  const status = blockers.length === 0 ? "ready_for_operator_adapter_review" : "blocked";
  const remainingBlockers = [...new Set([...blockers, ...upstreamBlockers])];
  const reportPath = path.join(stateRoot, "openclaw-capital-live-readiness-gate-latest.json");
  const panelPath = path.join(tradingRoot, "capital-live-readiness-gate.json");
  const markdownPath = path.join(stateRoot, "openclaw-capital-live-readiness-gate-latest.md");
  const machineLine = [
    `capitalLiveReadiness=${status}`,
    `sha256=${sealedOrderIntentSha256 || "missing"}`,
    `quote=${platform.quote?.overallFreshness || "missing"}`,
    `position=${positionStatus || "missing"}`,
    `ack=${ackStatus || "missing"}`,
    `ackGate=${adapterAckGate.status || "missing"}`,
    `hashOk=${adapterAckGate.ack?.hashOk === true}`,
    `promotion=${promotionReady ? "ready" : "blocked"}`,
    `operator=${operator.status || "missing"}`,
    `executorArm=${armProfile.status || "missing"}`,
    `executorArmed=${liveExecutorArmed}`,
    "noOrderWrite=true",
    "sentOrder=false",
    `blockers=${blockers.length}`,
  ].join(" ");

  return {
    schema: SCHEMA,
    generatedAt,
    status,
    mode: "read_only_live_readiness_aggregation",
    sealedOrderIntentSha256,
    machineLine,
    checks,
    blockers,
    upstreamBlockers,
    remainingBlockers,
    readiness: {
      directTrade: {
        instrument: platform.strategyPlatform?.requestedTrade?.instrument || "A50 202605",
        holdingMode: platform.strategyPlatform?.requestedTrade?.holdingMode || "day_trade",
      },
      quote: {
        overallFreshness: platform.quote?.overallFreshness || "",
        strategyQuoteReady: platform.quote?.strategyQuoteReady === true,
        a50Status: platform.quote?.a50?.status || "",
        multiTargetStatus: platform.quote?.multiTarget?.status || "",
        multiTargetFreshCount: platform.quote?.multiTarget?.freshPaperTargetCount ?? 0,
      },
      strategy: {
        platformStatus: platform.status || "",
        strategyFillStatus: platform.strategy?.strategyFill?.status || "",
        strategyFillRecommendation: platform.strategy?.strategyFill?.recommendation || "",
        paperPromotionEligible:
          platform.strategy?.strategyFill?.promotionGate?.paperPromotionEligible === true,
        tailRiskRepairStatus: platform.strategy?.strategyTailRiskRepair?.status || "",
        p05:
          platform.strategy?.strategyTailRiskRepair?.stressSummary?.p05 ??
          platform.strategy?.strategyFill?.stats?.p05 ??
          null,
        selectedSymbols: safeArray(platform.strategy?.strategyTailRiskRepair?.selectedSymbols),
      },
      direct: {
        status: direct.status || "",
        decision: direct.decision || "",
        preTradeAllowed: direct.preTradeRiskGate?.allowedToSend === true,
        sentOrder: direct.safety?.sentOrder === true,
        brokerApi: direct.liveOrderDraft?.brokerApi || "",
        orderSymbol: direct.liveOrderDraft?.commandPayload?.stockNo || "",
        dayTradeMode: direct.liveOrderDraft?.commandPayload?.dayTradeMode || "",
      },
      positionDecision: {
        status: positionStatus,
        usable: positionUsable,
        conclusion:
          platform.execution?.positionDecision?.conclusion ||
          direct.operatorHandoff?.positionDecision?.conclusion ||
          "",
      },
      externalBrokerAdapter: {
        required:
          platform.externalBrokerAdapter?.required ??
          direct.operatorHandoff?.externalBrokerAdapter?.required ??
          true,
        ackStatus,
        ackUsable,
        ackPath: ack.path || "",
        ackGateStatus: adapterAckGate.status || "",
        ackGateMachineLine: adapterAckGate.machineLine || "",
        hashOk: adapterAckGate.ack?.hashOk === true,
        canaryPass: adapterAckGate.ack?.canaryPass === true,
        rollbackPass: adapterAckGate.ack?.rollbackPass === true,
        requiredTemplatePath: adapterAckGate.ack?.requiredTemplatePath || "",
        refreshPlan: {
          status: adapterAckRefreshPlan.status || "",
          reason: adapterAckRefreshPlan.reason || "",
          sourcePath: adapterAckRefreshPlan.sourcePath || "",
          destinationPath: adapterAckRefreshPlan.destinationPath || "",
          expectedSealedIntentSha256: adapterAckRefreshPlan.expectedSealedIntentSha256 || "",
          actualSealedIntentSha256: adapterAckRefreshPlan.actualSealedIntentSha256 || "",
          candidateSealedIntentSha256: adapterAckRefreshPlan.candidateSealedIntentSha256 || "",
          candidateRollbackVerifiedAt: adapterAckRefreshPlan.candidateRollbackVerifiedAt || "",
          safeToPromoteCandidate: adapterAckRefreshPlan.safeToPromoteCandidate === true,
          activeAckWriteSuppressed: adapterAckRefreshPlan.activeAckWriteSuppressed === true,
          conversationAgentsMayWriteActiveAck:
            adapterAckRefreshPlan.conversationAgentsMayWriteActiveAck === true,
          allowedWriter: adapterAckRefreshPlan.allowedWriter || "",
          validationCommand: adapterAckRefreshPlan.validationCommand || "",
          postRefreshValidationCommand: adapterAckRefreshPlan.postRefreshValidationCommand || "",
        },
      },
      promotion: {
        status: promotion.status || "",
        blockerCode: promotion.blockerCode || "",
        readyForManualReview: promotion.readyForManualReview === true,
      },
      operator: {
        status: operator.status || "",
        action: operator.action || "",
        execute: operator.execute === true,
        applied: operator.applied === true,
        enabledAfter: operator.riskControls?.enabledAfter === true,
        allowLiveTrading: operator.riskControls?.allowLiveTrading === true,
        writeBrokerOrders: operator.riskControls?.writeBrokerOrders === true,
      },
      liveExecutorArmProfile: {
        status: armProfile.status || "",
        armed: armProfile.armed === true,
        allowExecutorWrite: armProfile.allowBrokerWriteWhenAllGatesPass === true,
        allowConversationAgentDirectWrite: armProfile.allowConversationAgentDirectWrite === true,
        brokerWriteAuthorityTarget: armProfile.brokerWriteAuthorityTarget || "",
        expiresAt: armProfile.expiresAt || "",
        profilePath: armProfile.paths?.profilePath || "",
        templatePath: armProfile.paths?.templatePath || "",
        blockers: armProfileBlockers,
      },
    },
    safety: {
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      externalWriteEnabled: false,
      brokerOrderPathEnabled: false,
      sendLiveOrderCapability: false,
      readOnlyPreflightOnly: true,
      mustBeExecutedByExternalOperatorOwnedBrokerAdapter: true,
      codexBrokerWriteAllowed: false,
      claudeBrokerWriteAllowed: false,
      openclawBrokerWriteAllowed: false,
      telegramBrokerWriteAllowed: false,
      sentOrder: false,
      noLiveOrderSent: true,
      no_live_order_sent: true,
      localBrokerExecutorArmed: liveExecutorArmed,
      localBrokerExecutorMayWriteAfterAllGates: false,
    },
    sourceStatus,
    paths: {
      reportPath,
      panelPath,
      markdownPath,
      platformReportPath: platform.paths?.reportPath || "",
      directReportPath: direct.scope?.statePath || "",
      adapterAckGateReportPath: adapterAckGate.paths?.reportPath || "",
      promotionReportPath: promotion.inputs?.reportPath || "",
      operatorReportPath: operator.reportPath || "",
      armProfileReportPath: armProfile.paths?.reportPath || "",
    },
    nextSafeTask:
      status === "ready_for_operator_adapter_review"
        ? "Live readiness 已通過；下一步仍需 operator packet 最終確認，不由對話代理直接送真單。"
        : "先修復 remainingBlockers，包含 live executor arm profile；重跑 pnpm capital:live-readiness:check。",
  };
}

export async function buildCapitalLiveReadinessGate(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const [
    platformResult,
    directResult,
    adapterAckResult,
    promotionResult,
    operatorResult,
    armProfileResult,
  ] = await Promise.all([
    captureGate(() => buildCapitalDirectStrategyPlatformGate({ repoRoot })),
    captureGate(() => buildCapitalLiveOrderDryRunPretradeGate({ repoRoot })),
    captureGate(() => buildCapitalExternalBrokerAdapterAckGate({ repoRoot })),
    captureGate(() => runCapitalLiveTradingPromotionGate({ writeState: false })),
    captureGate(() =>
      runCapitalLiveTradingOperatorGate({ action: "status", execute: false, writeState: false }),
    ),
    captureGate(() => buildCapitalLiveExecutorArmProfile({ repoRoot })),
  ]);

  return buildCapitalLiveReadinessReport({
    repoRoot,
    platform: sourceReport(platformResult),
    direct: sourceReport(directResult),
    adapterAckGate: sourceReport(adapterAckResult),
    promotion: sourceReport(promotionResult),
    operator: sourceReport(operatorResult),
    armProfile: sourceReport(armProfileResult),
    sourceStatus: {
      platform: { ok: platformResult.ok, error: sourceError(platformResult) },
      direct: { ok: directResult.ok, error: sourceError(directResult) },
      adapterAck: { ok: adapterAckResult.ok, error: sourceError(adapterAckResult) },
      promotion: { ok: promotionResult.ok, error: sourceError(promotionResult) },
      operator: { ok: operatorResult.ok, error: sourceError(operatorResult) },
      armProfile: { ok: armProfileResult.ok, error: sourceError(armProfileResult) },
    },
  });
}

async function main() {
  const report = await buildCapitalLiveReadinessGate({ repoRoot: process.cwd() });
  if (hasFlag("--write-state") || hasFlag("--check")) {
    await writeJsonWithSha(report.paths.reportPath, report);
    await writeJsonWithSha(report.paths.panelPath, report);
    await writeTextWithSha(report.paths.markdownPath, renderMarkdown(report));
  }
  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${report.machineLine}\nnextSafeTask=${report.nextSafeTask}\n`);
  }
}

if (process.argv[1] === currentFile) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
