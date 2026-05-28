#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCapitalExternalBrokerAdapterAckGate } from "./openclaw-capital-external-broker-adapter-ack-gate.mjs";
import { buildCapitalLiveOrderDryRunPretradeGate } from "./openclaw-capital-live-order-dry-run-pretrade-gate.mjs";
import { buildCapitalOverseasStaleRecovery } from "./openclaw-capital-overseas-stale-recovery.mjs";

const SCHEMA = "openclaw.capital.direct-operation-status.v1";
const POSITION_SNAPSHOT_MAX_FRESH_SECONDS = 12 * 60 * 60;

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJsonIfExists(filePath) {
  try {
    const text = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, "").trim();
    return text ? JSON.parse(text) : null;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error?.code)) {
      return null;
    }
    throw error;
  }
}

function parseArgs(argv) {
  const options = {
    check: false,
    json: false,
    writeState: false,
  };
  for (const arg of argv) {
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write-state") {
      options.writeState = true;
    }
  }
  return options;
}

function textValue(value, fallback = "unknown") {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boolPass(value) {
  return value === true ? "pass" : "blocked";
}

function pnpmCommand(repoRoot, scriptName) {
  return `pnpm --dir ${path.resolve(repoRoot)} ${scriptName}`;
}

function qualifyPnpmCommand(repoRoot, command) {
  const value = textValue(command, "");
  if (!value || !/^pnpm\s+/i.test(value) || /^pnpm\s+--dir\s+/i.test(value)) {
    return value;
  }
  return `pnpm --dir ${path.resolve(repoRoot)} ${value.replace(/^pnpm\s+/i, "")}`;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function detectDispatchExecution({ cronMinute, autopilotCycle, finalConfirmation }) {
  const cronSent = cronMinute?.action === "auto_dispatch_written" && cronMinute?.sentOrder === true;
  const autopilotSent =
    autopilotCycle?.status === "executed_dispatch_command_written" &&
    autopilotCycle?.safety?.sentOrder === true;
  const finalConfirmationSent =
    finalConfirmation?.status === "executor_dispatch_command_written" &&
    finalConfirmation?.safety?.sentOrder === true;

  if (cronSent) {
    return {
      dispatchWritten: true,
      source: "operator_cron_minute",
      generatedAt: textValue(cronMinute?.generatedAt, ""),
      commandSha256: textValue(cronMinute?.autopilot?.commandSha256, ""),
    };
  }
  if (autopilotSent) {
    return {
      dispatchWritten: true,
      source: "autopilot_cycle",
      generatedAt: textValue(autopilotCycle?.generatedAt, ""),
      commandSha256: textValue(autopilotCycle?.finalConfirmation?.commandSha256, ""),
    };
  }
  if (finalConfirmationSent) {
    return {
      dispatchWritten: true,
      source: "local_executor_final_confirmation",
      generatedAt: textValue(finalConfirmation?.generatedAt, ""),
      commandSha256: textValue(finalConfirmation?.executionReceipt?.commandSha256, ""),
    };
  }
  return {
    dispatchWritten: false,
    source: "",
    generatedAt: "",
    commandSha256: "",
  };
}

function timestampAgeSeconds(value, nowMs) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.floor((nowMs - parsed) / 1000));
}

function freshTimestamp(value, nowMs, maxFreshSeconds) {
  const age = timestampAgeSeconds(value, nowMs);
  return age !== null && age <= maxFreshSeconds;
}

function firstTarget(targets, symbol) {
  const normalized = String(symbol || "").toUpperCase();
  return (Array.isArray(targets) ? targets : []).find(
    (target) => String(target?.symbol || "").toUpperCase() === normalized,
  );
}

function buildA50QuoteGate({ quoteStatus, overseasRecovery, nowMs }) {
  const a50 = firstTarget(overseasRecovery?.targets, "CN0000") ?? {};
  const quoteProof = quoteStatus?.quoteProof ?? {};
  const latestQuote = quoteStatus?.diagnostics?.latestQuote ?? {};
  const latestQuoteStockNo = String(latestQuote.stockNo ?? "").toUpperCase();
  const maxFreshSeconds =
    finiteNumber(quoteProof.maxAllowedFreshAgeSeconds) ??
    finiteNumber(quoteProof.maxFreshSeconds) ??
    finiteNumber(overseasRecovery?.matrix?.maxFreshSeconds) ??
    300;
  const quoteProofAgeSeconds = finiteNumber(quoteProof.freshnessAgeSeconds);
  const latestQuoteAgeSeconds = timestampAgeSeconds(latestQuote.receivedAt, nowMs);
  const recoveryQuoteAgeSeconds = timestampAgeSeconds(a50.quote?.receivedAt, nowMs);
  const proofFresh =
    quoteStatus?.ready === true &&
    quoteStatus?.status === "ready" &&
    quoteProof.freshness === "fresh" &&
    quoteProof.freshnessStatus === "fresh" &&
    quoteProofAgeSeconds !== null &&
    quoteProofAgeSeconds <= maxFreshSeconds;
  // `capital-quote-status` may be generated from service-status mode where latestQuote
  // is empty or not A50-specific. Only treat latestQuote as a blocker when it explicitly
  // carries CN0000.
  const latestQuoteEvidenceRequired = latestQuoteStockNo === "CN0000";
  const latestQuoteFresh =
    latestQuoteEvidenceRequired && freshTimestamp(latestQuote.receivedAt, nowMs, maxFreshSeconds);
  const recoveryFresh =
    a50.status === "fresh" &&
    a50.ready === true &&
    finiteNumber(a50.ageSeconds) !== null &&
    a50.ageSeconds <= maxFreshSeconds &&
    freshTimestamp(a50.quote?.receivedAt, nowMs, maxFreshSeconds);
  const status =
    proofFresh && recoveryFresh && (!latestQuoteEvidenceRequired || latestQuoteFresh)
      ? "fresh"
      : "stale";
  const blockers = [];
  if (!proofFresh) {
    blockers.push("quote_status:a50_not_fresh");
  }
  if (latestQuoteEvidenceRequired && !latestQuoteFresh) {
    blockers.push("quote_status:a50_latest_quote_stale");
  }
  if (!recoveryFresh) {
    blockers.push("overseas_recovery:a50_not_wall_clock_fresh");
  }
  return {
    status,
    fresh: status === "fresh",
    subscribed: a50.subscribed === true,
    ageSeconds: quoteProofAgeSeconds ?? (Number.isFinite(a50.ageSeconds) ? a50.ageSeconds : null),
    wallClockAgeSeconds:
      latestQuoteEvidenceRequired && latestQuoteAgeSeconds !== null
        ? latestQuoteAgeSeconds
        : (recoveryQuoteAgeSeconds ?? latestQuoteAgeSeconds),
    maxFreshSeconds,
    quoteReceivedAt: textValue(
      latestQuoteEvidenceRequired
        ? latestQuote.receivedAt || a50.quote?.receivedAt
        : a50.quote?.receivedAt || latestQuote.receivedAt,
      "",
    ),
    recoveryReportedStatus: textValue(a50.status),
    recoveryReportedAgeSeconds: Number.isFinite(a50.ageSeconds) ? a50.ageSeconds : null,
    unblockCondition: textValue(a50.unblockCondition || quoteStatus?.reason, ""),
    blockers,
  };
}

function buildAdapterAckHandoff(adapterAckGate, repoRoot) {
  const ack = adapterAckGate?.ack ?? {};
  const operatorReview = adapterAckGate?.operatorReview ?? {};
  const activeVsCandidate = operatorReview.activeVsCandidate ?? {};
  const refreshPlan = operatorReview.refreshPlan ?? {};
  const handoffChecklist = safeArray(operatorReview.handoffChecklist)
    .map((item) => ({
      order: finiteNumber(item?.order),
      id: textValue(item?.id, ""),
      status: textValue(item?.status, ""),
      validationCommand: qualifyPnpmCommand(repoRoot, item?.validationCommand),
    }))
    .filter((item) => item.id.length > 0);
  const nextHandoffStep =
    handoffChecklist.find((item) => !["complete", "ready"].includes(item.status)) ??
    handoffChecklist[0] ??
    null;

  return {
    ackGateStatus: textValue(adapterAckGate?.status),
    machineLine: textValue(adapterAckGate?.machineLine, ""),
    hashOk: ack.hashOk === true,
    canaryPass: ack.canaryPass === true,
    canarySentOrder: ack.canarySentOrder === true,
    rollbackPass: ack.rollbackPass === true,
    rollbackFresh: ack.rollbackFresh === true,
    rollbackFreshnessStatus: textValue(ack.rollbackFreshnessStatus),
    expectedSealedIntentSha256: textValue(
      ack.sealedIntentHash?.expected || ack.expectedValue?.sealedIntentSha256,
      "",
    ),
    actualSealedIntentSha256: textValue(
      ack.sealedIntentHash?.actual || ack.currentValue?.sealedIntentSha256,
      "",
    ),
    activeAckPath: textValue(operatorReview.activeAckPath || ack.activePath, ""),
    stagedCandidateAckPath: textValue(
      operatorReview.stagedCandidateAckPath || adapterAckGate?.paths?.stagedCandidateAckPath,
      "",
    ),
    requiredTemplatePath: textValue(
      operatorReview.requiredTemplatePath ||
        adapterAckGate?.paths?.requiredTemplatePath ||
        ack.requiredTemplatePath,
      "",
    ),
    handoffStatus: textValue(operatorReview.status),
    activeVsCandidateStatus: textValue(activeVsCandidate.status),
    refreshPlan: {
      status: textValue(refreshPlan.status, ""),
      reason: textValue(refreshPlan.reason, ""),
      sourcePath: textValue(refreshPlan.sourcePath, ""),
      destinationPath: textValue(refreshPlan.destinationPath, ""),
      expectedSealedIntentSha256: textValue(refreshPlan.expectedSealedIntentSha256, ""),
      actualSealedIntentSha256: textValue(refreshPlan.actualSealedIntentSha256, ""),
      candidateSealedIntentSha256: textValue(refreshPlan.candidateSealedIntentSha256, ""),
      canaryPass: refreshPlan.canaryPass === true,
      canarySentOrder: refreshPlan.canarySentOrder === true,
      rollbackPass: refreshPlan.rollbackPass === true,
      rollbackFresh: refreshPlan.rollbackFresh === true,
      safeToPromoteCandidate: refreshPlan.safeToPromoteCandidate === true,
      activeAckWriteSuppressed: refreshPlan.activeAckWriteSuppressed === true,
      conversationAgentsMayWriteActiveAck: refreshPlan.conversationAgentsMayWriteActiveAck === true,
      allowedWriter: textValue(refreshPlan.allowedWriter, ""),
      validationCommand: qualifyPnpmCommand(repoRoot, refreshPlan.validationCommand),
      postRefreshValidationCommand: qualifyPnpmCommand(
        repoRoot,
        refreshPlan.postRefreshValidationCommand,
      ),
    },
    nextHandoffStep,
    handoffChecklist,
  };
}

function buildPositionSnapshotHandoff(
  positionSnapshot,
  positionFresh,
  positionVerifiedAgeSeconds,
  paths,
  repoRoot,
) {
  const usable = positionSnapshot.usable === true;
  const status = usable
    ? positionFresh
      ? "fresh"
      : "stale_operator_refresh_required"
    : "missing_operator_refresh_required";
  const handoffChecklist = [
    {
      order: 1,
      id: "review_current_broker_position",
      status: positionFresh ? "complete" : "pending_operator_review",
      validationCommand: pnpmCommand(repoRoot, "capital:trade:direct:status:check"),
    },
    {
      order: 2,
      id: "operator_refresh_position_snapshot",
      status: positionFresh ? "complete" : "pending_operator_owned_position_query",
      validationCommand: pnpmCommand(repoRoot, "capital:trade:direct:status:check"),
    },
    {
      order: 3,
      id: "rerun_direct_status",
      status: positionFresh ? "ready" : "blocked_until_position_refresh",
      validationCommand: pnpmCommand(repoRoot, "capital:trade:direct:status:check"),
    },
    {
      order: 4,
      id: "rerun_live_readiness",
      status: positionFresh ? "ready" : "blocked_until_position_refresh",
      validationCommand: pnpmCommand(repoRoot, "capital:live-readiness:check"),
    },
  ];
  const nextHandoffStep =
    handoffChecklist.find((item) => !["complete", "ready"].includes(item.status)) ??
    handoffChecklist[0] ??
    null;

  return {
    status,
    freshnessStatus: positionFresh ? "fresh" : "stale",
    activeSnapshotPath: textValue(positionSnapshot.path, ""),
    templatePath: textValue(paths.templatePath, ""),
    stagedRefreshPath: textValue(paths.stagedRefreshPath, ""),
    verifiedAt: textValue(positionSnapshot.verifiedAt, ""),
    verifiedBy: textValue(positionSnapshot.verifiedBy, ""),
    verifiedAgeSeconds: positionVerifiedAgeSeconds,
    maxFreshSeconds: POSITION_SNAPSHOT_MAX_FRESH_SECONDS,
    hasOpenPosition: positionSnapshot.hasOpenPosition === true,
    netContracts: Number.isFinite(positionSnapshot.netContracts)
      ? positionSnapshot.netContracts
      : 0,
    activeSnapshotWriteSuppressed: true,
    conversationAgentsMayWriteActiveSnapshot: false,
    allowedWriter: "operator-owned-position-query-only",
    validationCommand: pnpmCommand(repoRoot, "capital:trade:direct:status:check"),
    nextHandoffStep,
    handoffChecklist,
  };
}

function buildAutoDeactivateReceiptSummary(receiptGate, repoRoot) {
  const reportRead = receiptGate && typeof receiptGate === "object";
  const safety = reportRead && receiptGate.safety ? receiptGate.safety : {};
  const validationCommands =
    reportRead && receiptGate.validationCommands ? receiptGate.validationCommands : {};
  const status = reportRead ? textValue(receiptGate.status) : "missing";
  const blockers = reportRead
    ? safeArray(receiptGate.blockers).map(String).filter(Boolean)
    : ["auto_deactivate_receipt:missing"];
  const noLiveOrderSent = safety.noLiveOrderSent === true;
  const sentOrder = receiptGate?.sentOrder === true || safety.sentOrder === true;
  const writeBrokerOrders = safety.writeBrokerOrders === true;
  const liveTradingEnabled = safety.liveTradingEnabled === true;
  const heartbeatExecuteAllowed =
    receiptGate?.heartbeatExecuteAllowed === true || safety.heartbeatExecuteAllowed === true;
  return {
    required: true,
    reportRead: Boolean(reportRead),
    status,
    auditId: textValue(receiptGate?.auditId, ""),
    pendingExplicitExecuteReceipt: receiptGate?.pendingExplicitExecuteReceipt === true,
    receiptVerified: receiptGate?.receiptVerified === true,
    execute: receiptGate?.execute === true,
    applied: receiptGate?.applied === true,
    operatorActionRequired: receiptGate?.operatorActionRequired === true,
    heartbeatExecuteAllowed,
    validationCommand:
      qualifyPnpmCommand(repoRoot, validationCommands.receiptGate) ||
      pnpmCommand(repoRoot, "capital:live-trading:operator:auto-deactivate:receipt:check"),
    controlledRunCommand:
      qualifyPnpmCommand(repoRoot, validationCommands.controlledRun) ||
      pnpmCommand(repoRoot, "autonomous:controlled:run -- --json"),
    noLiveOrderSent,
    sentOrder,
    writeBrokerOrders,
    liveTradingEnabled,
    machineLine: textValue(receiptGate?.machineLine, ""),
    blockers,
    nextSafeTask: textValue(receiptGate?.nextSafeTask, ""),
  };
}

function buildAdapterApplyReceiptSummary(receiptGate, repoRoot) {
  const reportRead = receiptGate && typeof receiptGate === "object";
  const receipt = reportRead && receiptGate.operatorReceipt ? receiptGate.operatorReceipt : {};
  const handoff = reportRead && receiptGate.operatorHandoff ? receiptGate.operatorHandoff : {};
  const handoffSafety = handoff.safety && typeof handoff.safety === "object" ? handoff.safety : {};
  const safety = reportRead && receiptGate.safety ? receiptGate.safety : {};
  const validationCommands =
    reportRead && receiptGate.validationCommands ? receiptGate.validationCommands : {};
  const status = reportRead ? textValue(receiptGate.status) : "missing";
  const blockers = reportRead
    ? safeArray(receiptGate.blockers).map(String).filter(Boolean)
    : ["adapter_apply_receipt:missing"];
  const noLiveOrderSent = safety.noLiveOrderSent === true;
  const sentOrder = receiptGate?.sentOrder === true || safety.sentOrder === true;
  const writeBrokerOrders = safety.writeBrokerOrders === true;
  const liveTradingEnabled = safety.liveTradingEnabled === true;
  return {
    required: true,
    reportRead: Boolean(reportRead),
    status,
    verified:
      (status === "applied_receipt_verified" && receipt.operatorApplyVerified === true) ||
      (status === "no_apply_required" &&
        receipt.noApplyRequired === true &&
        receipt.operatorMayApply !== true),
    operatorMayApply: receipt.operatorMayApply === true,
    operatorApplyVerified: receipt.operatorApplyVerified === true,
    noApplyRequired: receipt.noApplyRequired === true,
    action: textValue(receipt.action, ""),
    owner: textValue(receipt.owner, ""),
    activeState: textValue(receipt.activeState, ""),
    sourcePath: textValue(receipt.sourcePath, ""),
    destinationPath: textValue(receipt.destinationPath, ""),
    backupPath: textValue(receipt.backupPath, ""),
    tempPath: textValue(receipt.tempPath, ""),
    sealedIntentSha256: textValue(
      receipt.sealedIntentSha256 || receiptGate?.sealedIntentSha256,
      "",
    ),
    validationCommand:
      qualifyPnpmCommand(
        repoRoot,
        validationCommands.receipt || receipt.validationCommands?.receipt,
      ) || pnpmCommand(repoRoot, "capital:trade:adapter-ack-apply-receipt:check"),
    postApplyClosureCommand:
      qualifyPnpmCommand(
        repoRoot,
        validationCommands.postApplyClosure || receipt.validationCommands?.postApplyClosure,
      ) || pnpmCommand(repoRoot, "capital:trade:post-apply-closure:check"),
    noLiveOrderSent,
    sentOrder,
    writeBrokerOrders,
    liveTradingEnabled,
    operatorHandoff: {
      status: textValue(handoff.status, ""),
      nextAction: textValue(handoff.nextAction, ""),
      allowedActor: textValue(handoff.allowedActor, ""),
      disallowedActors: safeArray(handoff.disallowedActors).map(String).filter(Boolean),
      sourcePath: textValue(handoff.sourcePath, ""),
      destinationPath: textValue(handoff.destinationPath, ""),
      sealedIntentSha256: textValue(handoff.sealedIntentSha256, ""),
      currentContentSha256: textValue(handoff.currentContentSha256, ""),
      candidateContentSha256: textValue(handoff.candidateContentSha256, ""),
      requiredValidation: safeArray(handoff.requiredValidation).map(String).filter(Boolean),
      brokerOrderWriteAllowed: handoffSafety.brokerOrderWriteAllowed === true,
      automationMayWriteActiveAck: handoffSafety.automationMayWriteActiveAck === true,
      telegramMayWriteActiveAck: handoffSafety.telegramMayWriteActiveAck === true,
      reportOnly: handoffSafety.reportOnly === true,
      noLiveOrderSent: handoffSafety.noLiveOrderSent === true,
    },
    machineLine: textValue(receiptGate?.machineLine, ""),
    blockers,
    nextSafeTask: textValue(receiptGate?.nextSafeTask, ""),
  };
}

function buildSummary({
  gate,
  serviceStatus,
  quoteStatus,
  overseasRecovery,
  liveRiskPositions,
  adapterAckGate,
  adapterApplyReceiptGate,
  autoDeactivateReceiptGate,
  operatorCronMinute,
  autopilotCycle,
  finalConfirmation,
  positionRefreshPaths,
  repoRoot,
  nowMs,
}) {
  const handoff = gate.operatorHandoff ?? {};
  const ack = handoff.externalBrokerAdapter?.ack ?? {};
  const positionSnapshot = handoff.positionSnapshot ?? {};
  const a50QuoteGate = buildA50QuoteGate({ quoteStatus, overseasRecovery, nowMs });
  const adapterApplyReceipt = buildAdapterApplyReceiptSummary(adapterApplyReceiptGate, repoRoot);
  const autoDeactivateReceipt = buildAutoDeactivateReceiptSummary(
    autoDeactivateReceiptGate,
    repoRoot,
  );
  const txQuote = quoteStatus?.quote ?? quoteStatus?.diagnostics?.latestQuote ?? {};
  const positionVerifiedAgeSeconds = timestampAgeSeconds(positionSnapshot.verifiedAt, nowMs);
  const dispatchExecution = detectDispatchExecution({
    cronMinute: operatorCronMinute,
    autopilotCycle,
    finalConfirmation,
  });
  const dispatchWritten = dispatchExecution.dispatchWritten === true;
  const positionFresh =
    positionSnapshot.usable === true &&
    positionVerifiedAgeSeconds !== null &&
    positionVerifiedAgeSeconds <= POSITION_SNAPSHOT_MAX_FRESH_SECONDS;
  const positionUsable = positionSnapshot.usable === true;
  const adapterUsable = ack.usable === true;
  const adapterApplyReceiptReady =
    adapterApplyReceipt.verified === true &&
    adapterApplyReceipt.owner === "operator-owned-broker-adapter-only" &&
    adapterApplyReceipt.noLiveOrderSent === true &&
    adapterApplyReceipt.sentOrder === false &&
    adapterApplyReceipt.writeBrokerOrders === false &&
    adapterApplyReceipt.liveTradingEnabled === false;
  const autoDeactivateReceiptReady =
    autoDeactivateReceipt.receiptVerified === true &&
    autoDeactivateReceipt.heartbeatExecuteAllowed === false &&
    autoDeactivateReceipt.noLiveOrderSent === true &&
    autoDeactivateReceipt.sentOrder === false &&
    autoDeactivateReceipt.writeBrokerOrders === false &&
    autoDeactivateReceipt.liveTradingEnabled === false;
  const liveReady =
    gate.preTradeRiskGate?.allowedToSend === true &&
    a50QuoteGate.fresh === true &&
    positionUsable &&
    adapterUsable &&
    adapterApplyReceiptReady &&
    autoDeactivateReceiptReady;
  const rawBlockers = [
    ...(Array.isArray(gate.preTradeRiskGate?.blockers) ? gate.preTradeRiskGate.blockers : []),
    ...(Array.isArray(serviceStatus?.failedSteps) ? serviceStatus.failedSteps : []),
    ...(Array.isArray(overseasRecovery?.failedSteps) ? overseasRecovery.failedSteps : []),
    ...(Array.isArray(liveRiskPositions?.blockers) ? liveRiskPositions.blockers : []),
    ...a50QuoteGate.blockers,
    ...(adapterApplyReceiptReady
      ? []
      : adapterApplyReceipt.blockers.length > 0
        ? adapterApplyReceipt.blockers.map((item) => `adapterApplyReceipt:${item}`)
        : [`adapter_apply_receipt:${adapterApplyReceipt.status}`]),
    ...(autoDeactivateReceiptReady
      ? []
      : autoDeactivateReceipt.blockers.length > 0
        ? autoDeactivateReceipt.blockers
        : [`auto_deactivate_receipt:${autoDeactivateReceipt.status}`]),
  ];
  const blockers = liveReady
    ? [...new Set(rawBlockers.filter((item) => String(item).startsWith("risk-controls")))]
    : dispatchWritten
      ? [...new Set(rawBlockers.filter((item) => String(item).startsWith("risk-controls")))]
      : [...new Set(rawBlockers.filter(Boolean))];
  const status = liveReady
    ? "live_ready_to_send"
    : dispatchWritten
      ? "dispatch_written_pending_fill"
      : "blocked";
  const conclusion = liveReady
    ? "真實下單已開放：可透過 operator-owned broker adapter 直接進出場。"
    : dispatchWritten
      ? "已寫入自動派單命令；目前等待券商成交/回報與後續倉位同步。"
      : "不進場、不出場、不送單；等待 fresh quote、verified position snapshot、external broker adapter ack、canary/rollback/promotion gate 全部通過。";

  return {
    status,
    conclusion,
    directEntryPoints: {
      openclaw: pnpmCommand(repoRoot, "capital:trade:direct:status"),
      codex: pnpmCommand(repoRoot, "capital:trade:direct:check"),
      claude: pnpmCommand(repoRoot, "capital:trade:direct:check"),
      telegram: "sc:tr:direct",
    },
    quote: {
      serviceStatus: textValue(serviceStatus?.status),
      blockerCode: textValue(serviceStatus?.blockerCode, ""),
      domesticTxStatus: textValue(quoteStatus?.status),
      domesticTxSession: textValue(quoteStatus?.session?.marketSession),
      domesticTxFreshness: textValue(quoteStatus?.quoteProof?.freshness),
      domesticTxStockNo: textValue(txQuote.stockNo, ""),
      domesticTxReceivedAt: textValue(txQuote.receivedAt, ""),
      a50Status: a50QuoteGate.status,
      a50Subscribed: a50QuoteGate.subscribed,
      a50AgeSeconds: a50QuoteGate.ageSeconds,
      a50WallClockAgeSeconds: a50QuoteGate.wallClockAgeSeconds,
      a50MaxFreshSeconds: a50QuoteGate.maxFreshSeconds,
      a50QuoteReceivedAt: a50QuoteGate.quoteReceivedAt,
      a50RecoveryReportedStatus: a50QuoteGate.recoveryReportedStatus,
      a50RecoveryReportedAgeSeconds: a50QuoteGate.recoveryReportedAgeSeconds,
      a50UnblockCondition: a50QuoteGate.unblockCondition,
    },
    requestedTrade: {
      instrument: "A50 202605",
      quoteSymbol: "CN0000",
      holdingMode: "day_trade",
      orderApi: "SendOverseaFutureOrder",
      status: liveReady
        ? "live_ready_to_send"
        : dispatchWritten
          ? "dispatch_written_pending_fill"
          : a50QuoteGate.fresh === true
            ? "blocked_until_position_and_adapter"
            : "blocked_a50_stale",
      conclusion: liveReady
        ? "A50 真實單已開放；已具備 direct live order 條件。"
        : dispatchWritten
          ? "A50 指令已進入自動派單，等待成交回報與倉位更新。"
          : a50QuoteGate.fresh === true
            ? "A50 報價已可進入後續 gate，但仍需 verified position snapshot 與 external adapter ack。"
            : "A50 202605 當沖請求已記錄；目前 A50 quote stale，不可作為即時進出場依據。",
    },
    position: {
      status: textValue(positionSnapshot.status),
      usable: positionSnapshot.usable === true,
      path: textValue(positionSnapshot.path, ""),
      verifiedAt: textValue(positionSnapshot.verifiedAt, ""),
      verifiedBy: textValue(positionSnapshot.verifiedBy, ""),
      verifiedAgeSeconds: positionVerifiedAgeSeconds,
      maxFreshSeconds: POSITION_SNAPSHOT_MAX_FRESH_SECONDS,
      freshnessStatus: positionFresh ? "fresh" : "stale",
      hasOpenPosition: positionSnapshot.hasOpenPosition === true,
      netContracts: Number.isFinite(positionSnapshot.netContracts)
        ? positionSnapshot.netContracts
        : 0,
      decisionStatus: textValue(handoff.positionDecision?.status),
      decisionConclusion: textValue(handoff.positionDecision?.conclusion, ""),
      handoff: buildPositionSnapshotHandoff(
        positionSnapshot,
        positionFresh,
        positionVerifiedAgeSeconds,
        positionRefreshPaths,
        repoRoot,
      ),
    },
    externalBrokerAdapter: {
      required: handoff.externalBrokerAdapter?.required === true,
      ackStatus: textValue(ack.status),
      ackUsable: ack.usable === true,
      ackPath: textValue(ack.path, ""),
      requiredSealedIntentSha256: textValue(ack.requiredSealedIntentSha256, ""),
      currentLivePolicy: textValue(handoff.externalBrokerAdapter?.currentLivePolicy),
      handoff: buildAdapterAckHandoff(adapterAckGate, repoRoot),
      applyReceipt: adapterApplyReceipt,
    },
    autoDeactivateReceipt,
    sealedOrderIntent: {
      status: textValue(handoff.handoffPacket?.sealedOrderIntent?.status),
      sha256: textValue(handoff.handoffPacket?.sealedOrderIntent?.sha256, ""),
      destination: textValue(handoff.handoffPacket?.sealedOrderIntent?.destination, ""),
      brokerWriteAllowedByOpenClaw: false,
      stockNo: textValue(handoff.handoffPacket?.sealedOrderIntent?.commandPayload?.stockNo, ""),
      dayTradeMode: textValue(
        handoff.handoffPacket?.sealedOrderIntent?.commandPayload?.dayTradeMode,
        "",
      ),
    },
    safety: {
      noLiveOrderSent: dispatchWritten ? false : gate.safety?.noLiveOrderSent === true,
      sentOrder: dispatchWritten,
      liveTradingEnabled: liveReady || dispatchWritten,
      writeBrokerOrders: liveReady || dispatchWritten,
      brokerWriteAttempted: dispatchWritten,
      directGate: dispatchWritten ? "dispatch_written" : boolPass(liveReady),
    },
    execution: {
      dispatchWritten,
      source: dispatchExecution.source,
      generatedAt: dispatchExecution.generatedAt,
      commandSha256: dispatchExecution.commandSha256,
    },
    blockers,
    nextRequiredFiles: {
      verifiedPositionSnapshot: positionSnapshot.template
        ? {
            path: positionSnapshot.path,
            schema: positionSnapshot.expectedSchema,
            template: positionSnapshot.template,
          }
        : null,
      externalBrokerAdapterAck: ack.template
        ? {
            path: ack.path,
            schema: ack.expectedSchema,
            template: ack.template,
          }
        : null,
    },
  };
}

function renderMarkdown(report) {
  const summary = report.summary;
  return [
    "# Capital Direct Operation Status",
    "",
    `generatedAt: ${report.generatedAt}`,
    `status: ${summary.status}`,
    `conclusion: ${summary.conclusion}`,
    "",
    "## Entry Points",
    "",
    `- OpenClaw: ${summary.directEntryPoints.openclaw}`,
    `- Codex: ${summary.directEntryPoints.codex}`,
    `- Claude: ${summary.directEntryPoints.claude}`,
    `- Telegram: ${summary.directEntryPoints.telegram}`,
    "",
    "## Current Gates",
    "",
    `- TX: ${summary.quote.domesticTxStatus} / ${summary.quote.domesticTxFreshness} / ${summary.quote.domesticTxStockNo}`,
    `- A50: ${summary.quote.a50Status} / subscribed=${summary.quote.a50Subscribed} / ageSeconds=${summary.quote.a50AgeSeconds}`,
    `- Requested trade: ${summary.requestedTrade.instrument} / ${summary.requestedTrade.holdingMode} / ${summary.requestedTrade.status}`,
    `- Position: ${summary.position.decisionStatus} / ${summary.position.freshnessStatus} / ageSeconds=${summary.position.verifiedAgeSeconds}`,
    `- Position handoff: ${summary.position.handoff.status} / next=${summary.position.handoff.nextHandoffStep?.id || "none"}`,
    `- Adapter ack: ${summary.externalBrokerAdapter.ackStatus}`,
    `- Adapter ack gate: ${summary.externalBrokerAdapter.handoff.ackGateStatus} / hashOk=${summary.externalBrokerAdapter.handoff.hashOk}`,
    `- Adapter ack refreshPlan: ${summary.externalBrokerAdapter.handoff.refreshPlan.status || "missing"} / safeToPromoteCandidate=${summary.externalBrokerAdapter.handoff.refreshPlan.safeToPromoteCandidate}`,
    `- Adapter ack handoff: ${summary.externalBrokerAdapter.handoff.handoffStatus} / next=${summary.externalBrokerAdapter.handoff.nextHandoffStep?.id || "none"}`,
    `- Adapter apply receipt: ${summary.externalBrokerAdapter.applyReceipt.status} / verified=${summary.externalBrokerAdapter.applyReceipt.verified} / owner=${summary.externalBrokerAdapter.applyReceipt.owner || "missing"}`,
    `- Auto-deactivate receipt: ${summary.autoDeactivateReceipt.status} / pending=${summary.autoDeactivateReceipt.pendingExplicitExecuteReceipt} / verified=${summary.autoDeactivateReceipt.receiptVerified} / heartbeatExecuteAllowed=${summary.autoDeactivateReceipt.heartbeatExecuteAllowed}`,
    `- Sealed intent: ${summary.sealedOrderIntent.sha256}`,
    `- noLiveOrderSent: ${summary.safety.noLiveOrderSent}`,
    "",
    "## Blockers",
    "",
    summary.blockers.length ? summary.blockers.map((item) => `- ${item}`).join("\n") : "- none",
    "",
  ].join("\n");
}

async function loadOverseasRecovery({ repoRoot, stateRoot }) {
  const reportPath = path.join(stateRoot, "openclaw-capital-overseas-stale-recovery-latest.json");
  try {
    return await buildCapitalOverseasStaleRecovery({ repoRoot });
  } catch {
    return await readJsonIfExists(reportPath);
  }
}

export async function buildCapitalDirectOperationStatus(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const gate = await buildCapitalLiveOrderDryRunPretradeGate({ repoRoot });
  const [
    serviceStatus,
    quoteStatus,
    overseasRecovery,
    liveRiskPositions,
    adapterAckGate,
    adapterApplyReceiptGate,
    autoDeactivateReceiptGate,
    operatorCronMinute,
    autopilotCycle,
    finalConfirmation,
  ] = await Promise.all([
    readJsonIfExists(path.join(stateRoot, "openclaw-capital-service-status-latest.json")),
    readJsonIfExists(path.join(repoRoot, ".openclaw", "quote", "capital-quote-status.json")),
    loadOverseasRecovery({ repoRoot, stateRoot }),
    readJsonIfExists(path.join(stateRoot, "openclaw-capital-live-risk-positions-gate-latest.json")),
    buildCapitalExternalBrokerAdapterAckGate({ repoRoot }),
    readJsonIfExists(
      path.join(stateRoot, "openclaw-capital-adapter-ack-operator-apply-receipt-gate-latest.json"),
    ),
    readJsonIfExists(
      path.join(
        stateRoot,
        "openclaw-capital-live-trading-operator-auto-deactivate-receipt-gate-latest.json",
      ),
    ),
    readJsonIfExists(
      path.join(stateRoot, "openclaw-capital-live-trading-operator-cron-minute-latest.json"),
    ),
    readJsonIfExists(
      path.join(stateRoot, "openclaw-capital-live-trading-autopilot-cycle-latest.json"),
    ),
    readJsonIfExists(
      path.join(stateRoot, "openclaw-capital-local-executor-final-confirmation-latest.json"),
    ),
  ]);
  const reportPath = path.join(stateRoot, "openclaw-capital-direct-operation-status-latest.json");
  const markdownPath = path.join(stateRoot, "openclaw-capital-direct-operation-status-latest.md");
  const panelPath = path.join(tradingRoot, "capital-direct-operation-status.json");
  const positionRefreshPaths = {
    templatePath: path.join(
      tradingRoot,
      "templates",
      "capital-verified-position-snapshot.template.json",
    ),
    stagedRefreshPath: path.join(
      tradingRoot,
      "staging",
      "capital-verified-position-snapshot.staged-refresh.json",
    ),
  };
  const generatedAt = new Date().toISOString();
  const report = {
    schema: SCHEMA,
    generatedAt,
    repoRoot,
    status: "blocked",
    summary: buildSummary({
      gate,
      serviceStatus,
      quoteStatus,
      overseasRecovery,
      liveRiskPositions,
      adapterAckGate,
      adapterApplyReceiptGate,
      autoDeactivateReceiptGate,
      operatorCronMinute,
      autopilotCycle,
      finalConfirmation,
      positionRefreshPaths,
      repoRoot,
      nowMs: Date.parse(generatedAt),
    }),
    sourceReports: {
      directGate: gate.scope?.statePath ?? "",
      serviceStatus: path.join(stateRoot, "openclaw-capital-service-status-latest.json"),
      quoteStatus: path.join(repoRoot, ".openclaw", "quote", "capital-quote-status.json"),
      overseasRecovery: path.join(
        stateRoot,
        "openclaw-capital-overseas-stale-recovery-latest.json",
      ),
      liveRiskPositions: path.join(
        stateRoot,
        "openclaw-capital-live-risk-positions-gate-latest.json",
      ),
      adapterAckGate: adapterAckGate.paths?.reportPath ?? "",
      adapterApplyReceiptGate: path.join(
        stateRoot,
        "openclaw-capital-adapter-ack-operator-apply-receipt-gate-latest.json",
      ),
      autoDeactivateReceiptGate: path.join(
        stateRoot,
        "openclaw-capital-live-trading-operator-auto-deactivate-receipt-gate-latest.json",
      ),
      operatorCronMinute: path.join(
        stateRoot,
        "openclaw-capital-live-trading-operator-cron-minute-latest.json",
      ),
      autopilotCycle: path.join(
        stateRoot,
        "openclaw-capital-live-trading-autopilot-cycle-latest.json",
      ),
      finalConfirmation: path.join(
        stateRoot,
        "openclaw-capital-local-executor-final-confirmation-latest.json",
      ),
    },
    paths: {
      reportPath,
      markdownPath,
      panelPath,
    },
    nextSafeTask:
      "建立 operator-owned external broker adapter ack 與 verified position snapshot 的輸入/顯示流程；仍不得由 Codex/OpenClaw 直接送真單。",
  };
  report.status = report.summary.status;
  report.nextSafeTask =
    report.summary.status === "live_ready_to_send"
      ? "進入 operator-owned adapter dry-run handoff；OpenClaw/Codex 仍不持有券商寫入權限。"
      : report.summary.status === "dispatch_written_pending_fill"
        ? "立即重跑 capital:trade:direct:status:check 與 capital:live-readiness:check，等待成交回報與倉位同步。"
        : report.summary.externalBrokerAdapter.applyReceipt.verified !== true &&
            report.summary.externalBrokerAdapter.applyReceipt.nextSafeTask
          ? report.summary.externalBrokerAdapter.applyReceipt.nextSafeTask
          : report.nextSafeTask;
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildCapitalDirectOperationStatus({ repoRoot: process.cwd() });
  if (options.writeState || options.check) {
    await writeJsonWithSha(report.paths.reportPath, report);
    await writeJsonWithSha(report.paths.panelPath, report);
    await writeTextWithSha(report.paths.markdownPath, renderMarkdown(report));
  }
  if (options.check) {
    if (report.summary.status === "dispatch_written_pending_fill") {
      if (
        report.summary.safety.sentOrder !== true ||
        report.summary.safety.noLiveOrderSent !== false
      ) {
        throw new Error("CAPITAL_DIRECT_OPERATION_STATUS_DISPATCH_SAFETY_MISMATCH");
      }
    } else if (
      report.summary.safety.noLiveOrderSent !== true ||
      report.summary.safety.sentOrder !== false
    ) {
      throw new Error("CAPITAL_DIRECT_OPERATION_STATUS_SAFETY_MISMATCH");
    }
  }
  if (options.json || options.check) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `CAPITAL_DIRECT_OPERATION_STATUS=${report.status} tx=${report.summary.quote.domesticTxStatus} a50=${report.summary.quote.a50Status} position=${report.summary.position.decisionStatus} positionFreshness=${report.summary.position.freshnessStatus} nextPositionStep=${report.summary.position.handoff.nextHandoffStep?.id || "none"} ack=${report.summary.externalBrokerAdapter.ackStatus} ackGate=${report.summary.externalBrokerAdapter.handoff.ackGateStatus} hashOk=${report.summary.externalBrokerAdapter.handoff.hashOk} ackRefreshPlan=${report.summary.externalBrokerAdapter.handoff.refreshPlan.status || "missing"} nextAckStep=${report.summary.externalBrokerAdapter.handoff.nextHandoffStep?.id || "none"} adapterApplyReceipt=${report.summary.externalBrokerAdapter.applyReceipt.status} adapterApplyReceiptVerified=${report.summary.externalBrokerAdapter.applyReceipt.verified} autoDeactivateReceipt=${report.summary.autoDeactivateReceipt.status} receiptVerified=${report.summary.autoDeactivateReceipt.receiptVerified} noLiveOrderSent=${report.summary.safety.noLiveOrderSent}\n`,
    );
  }
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
