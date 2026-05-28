#!/usr/bin/env node
import { buildCapitalDirectOperationStatus } from "./openclaw-capital-direct-operation-status.mjs";

const report = await buildCapitalDirectOperationStatus({ repoRoot: process.cwd() });
const issues = [];

if (report.schema !== "openclaw.capital.direct-operation-status.v1") {
  issues.push("schema mismatch");
}
const allowedStatuses = new Set(["blocked", "live_ready_to_send", "dispatch_written_pending_fill"]);
if (!allowedStatuses.has(report.status) || !allowedStatuses.has(report.summary?.status)) {
  issues.push(`status=${report.status}/${report.summary?.status}`);
}
const dispatchWritten = report.summary?.status === "dispatch_written_pending_fill";
if (dispatchWritten) {
  if (report.summary?.safety?.noLiveOrderSent !== false) {
    issues.push("dispatch written state must set noLiveOrderSent=false");
  }
  if (report.summary?.safety?.sentOrder !== true) {
    issues.push("dispatch written state must set sentOrder=true");
  }
  if (report.summary?.safety?.liveTradingEnabled !== true) {
    issues.push("dispatch written state must set liveTradingEnabled=true");
  }
  if (report.summary?.safety?.writeBrokerOrders !== true) {
    issues.push("dispatch written state must set writeBrokerOrders=true");
  }
} else {
  if (report.summary?.safety?.noLiveOrderSent !== true) {
    issues.push("noLiveOrderSent must stay true");
  }
  if (report.summary?.safety?.sentOrder !== false) {
    issues.push("sentOrder must stay false");
  }
  if (report.summary?.safety?.liveTradingEnabled !== false) {
    issues.push("liveTradingEnabled must stay false");
  }
  if (report.summary?.safety?.writeBrokerOrders !== false) {
    issues.push("writeBrokerOrders must stay false");
  }
}
if (report.summary?.sealedOrderIntent?.brokerWriteAllowedByOpenClaw !== false) {
  issues.push("sealed intent must not allow OpenClaw broker write");
}
if (!report.summary?.sealedOrderIntent?.sha256) {
  issues.push("sealed intent hash missing");
}
if (report.summary?.externalBrokerAdapter?.required !== true) {
  issues.push("external broker adapter requirement missing");
}
if (!report.summary?.externalBrokerAdapter?.ackPath) {
  issues.push("external broker adapter ack path missing");
}
const adapterHandoff = report.summary?.externalBrokerAdapter?.handoff;
if (!adapterHandoff || typeof adapterHandoff !== "object") {
  issues.push("adapter ack handoff summary missing");
} else {
  if (!["blocked", "verified"].includes(adapterHandoff.ackGateStatus)) {
    issues.push(`adapter ack gate status=${adapterHandoff.ackGateStatus}`);
  }
  if (typeof adapterHandoff.hashOk !== "boolean") {
    issues.push("adapter handoff hashOk must be boolean");
  }
  if (typeof adapterHandoff.canaryPass !== "boolean") {
    issues.push("adapter handoff canaryPass must be boolean");
  }
  if (typeof adapterHandoff.rollbackPass !== "boolean") {
    issues.push("adapter handoff rollbackPass must be boolean");
  }
  if (!adapterHandoff.activeAckPath) {
    issues.push("adapter handoff active ack path missing");
  }
  if (!adapterHandoff.stagedCandidateAckPath) {
    issues.push("adapter handoff staged candidate path missing");
  }
  if (!adapterHandoff.requiredTemplatePath) {
    issues.push("adapter handoff required template path missing");
  }
  if (!["matching", "mismatch"].includes(adapterHandoff.activeVsCandidateStatus)) {
    issues.push(`adapter activeVsCandidate=${adapterHandoff.activeVsCandidateStatus}`);
  }
  const refreshPlan = adapterHandoff.refreshPlan;
  if (!refreshPlan || typeof refreshPlan !== "object") {
    issues.push("adapter handoff refreshPlan missing");
  } else {
    if (!["not_required", "operator_refresh_required"].includes(refreshPlan.status)) {
      issues.push(`adapter refreshPlan status=${refreshPlan.status}`);
    }
    if (typeof refreshPlan.reason !== "string" || refreshPlan.reason.length === 0) {
      issues.push("adapter refreshPlan reason missing");
    }
    if (!refreshPlan.sourcePath) {
      issues.push("adapter refreshPlan source path missing");
    }
    if (!refreshPlan.destinationPath) {
      issues.push("adapter refreshPlan destination path missing");
    }
    if (typeof refreshPlan.safeToPromoteCandidate !== "boolean") {
      issues.push("adapter refreshPlan safeToPromoteCandidate must be boolean");
    }
    if (refreshPlan.activeAckWriteSuppressed !== true) {
      issues.push("adapter refreshPlan must suppress active ack writes");
    }
    if (refreshPlan.conversationAgentsMayWriteActiveAck !== false) {
      issues.push("conversation agents must not write active ack");
    }
    if (refreshPlan.allowedWriter !== "operator-owned-broker-adapter-only") {
      issues.push(`adapter refreshPlan allowedWriter=${refreshPlan.allowedWriter}`);
    }
    for (const commandKey of ["validationCommand", "postRefreshValidationCommand"]) {
      const command = String(refreshPlan[commandKey] || "");
      if (!command.startsWith("pnpm --dir ")) {
        issues.push(`adapter refreshPlan ${commandKey} must be repo-root qualified`);
      }
    }
    if (adapterHandoff.hashOk === false) {
      if (refreshPlan.status !== "operator_refresh_required") {
        issues.push(`adapter refreshPlan blocked status=${refreshPlan.status}`);
      }
      if (refreshPlan.reason !== "active_ack_hash_mismatch") {
        issues.push(`adapter refreshPlan blocked reason=${refreshPlan.reason}`);
      }
    }
  }
  if (
    !Array.isArray(adapterHandoff.handoffChecklist) ||
    adapterHandoff.handoffChecklist.length < 5
  ) {
    issues.push("adapter handoff checklist missing");
  }
  if (!adapterHandoff.nextHandoffStep?.id) {
    issues.push("adapter handoff next step missing");
  }
}
const adapterApplyReceipt = report.summary?.externalBrokerAdapter?.applyReceipt;
if (!adapterApplyReceipt || typeof adapterApplyReceipt !== "object") {
  issues.push("adapter apply receipt summary missing");
} else {
  if (adapterApplyReceipt.required !== true) {
    issues.push("adapter apply receipt requirement missing");
  }
  if (
    ![
      "missing",
      "pending_operator_apply",
      "applied_receipt_verified",
      "no_apply_required",
      "blocked_apply_receipt_incomplete",
      "blocked_safety_reconcile_required",
    ].includes(adapterApplyReceipt.status)
  ) {
    issues.push(`adapter apply receipt status=${adapterApplyReceipt.status}`);
  }
  if (adapterApplyReceipt.owner !== "operator-owned-broker-adapter-only") {
    issues.push(`adapter apply receipt owner=${adapterApplyReceipt.owner}`);
  }
  if (typeof adapterApplyReceipt.verified !== "boolean") {
    issues.push("adapter apply receipt verified must be boolean");
  }
  if (typeof adapterApplyReceipt.operatorMayApply !== "boolean") {
    issues.push("adapter apply receipt operatorMayApply must be boolean");
  }
  if (typeof adapterApplyReceipt.operatorApplyVerified !== "boolean") {
    issues.push("adapter apply receipt operatorApplyVerified must be boolean");
  }
  if (typeof adapterApplyReceipt.noApplyRequired !== "boolean") {
    issues.push("adapter apply receipt noApplyRequired must be boolean");
  }
  if (!String(adapterApplyReceipt.validationCommand || "").startsWith("pnpm --dir ")) {
    issues.push("adapter apply receipt validation command must be repo-root qualified");
  }
  if (!String(adapterApplyReceipt.postApplyClosureCommand || "").startsWith("pnpm --dir ")) {
    issues.push("adapter apply receipt post-apply command must be repo-root qualified");
  }
  if (adapterApplyReceipt.noLiveOrderSent !== true) {
    issues.push("adapter apply receipt noLiveOrderSent must stay true");
  }
  if (adapterApplyReceipt.sentOrder !== false) {
    issues.push("adapter apply receipt sentOrder must stay false");
  }
  if (adapterApplyReceipt.writeBrokerOrders !== false) {
    issues.push("adapter apply receipt writeBrokerOrders must stay false");
  }
  if (adapterApplyReceipt.liveTradingEnabled !== false) {
    issues.push("adapter apply receipt liveTradingEnabled must stay false");
  }
  const receiptHandoff = adapterApplyReceipt.operatorHandoff;
  if (!receiptHandoff || typeof receiptHandoff !== "object") {
    issues.push("adapter apply receipt operator handoff missing");
  } else {
    if (receiptHandoff.allowedActor !== "operator-controlled-broker-adapter") {
      issues.push(`adapter apply receipt handoff allowedActor=${receiptHandoff.allowedActor}`);
    }
    if (!Array.isArray(receiptHandoff.requiredValidation)) {
      issues.push("adapter apply receipt handoff requiredValidation missing");
    }
    if (receiptHandoff.brokerOrderWriteAllowed !== false) {
      issues.push("adapter apply receipt handoff brokerOrderWriteAllowed must stay false");
    }
    if (receiptHandoff.automationMayWriteActiveAck !== false) {
      issues.push("adapter apply receipt handoff automationMayWriteActiveAck must stay false");
    }
    if (receiptHandoff.telegramMayWriteActiveAck !== false) {
      issues.push("adapter apply receipt handoff telegramMayWriteActiveAck must stay false");
    }
    if (receiptHandoff.noLiveOrderSent !== true) {
      issues.push("adapter apply receipt handoff noLiveOrderSent must stay true");
    }
  }
  if (adapterApplyReceipt.status === "pending_operator_apply") {
    if (adapterApplyReceipt.operatorMayApply !== true) {
      issues.push("adapter apply receipt pending must expose operatorMayApply");
    }
    if (adapterApplyReceipt.verified !== false) {
      issues.push("adapter apply receipt pending must not be verified");
    }
    if (
      !Array.isArray(report.summary?.blockers) ||
      !report.summary.blockers.includes("adapterApplyReceipt:operator-apply:pending")
    ) {
      issues.push("adapter apply receipt pending blocker missing from direct blockers");
    }
    if (receiptHandoff?.nextAction !== "operator_adapter_atomic_apply") {
      issues.push("adapter apply receipt pending handoff nextAction must be operator apply");
    }
  }
  if (adapterApplyReceipt.status === "applied_receipt_verified") {
    if (
      adapterApplyReceipt.verified !== true ||
      adapterApplyReceipt.operatorApplyVerified !== true
    ) {
      issues.push("adapter apply receipt applied status must be verified");
    }
    if (receiptHandoff?.nextAction !== "rerun_post_apply_closure") {
      issues.push("adapter apply receipt applied handoff nextAction must rerun closure");
    }
  }
  if (adapterApplyReceipt.status === "no_apply_required") {
    if (
      adapterApplyReceipt.verified !== true ||
      adapterApplyReceipt.noApplyRequired !== true ||
      adapterApplyReceipt.operatorMayApply !== false ||
      adapterApplyReceipt.operatorApplyVerified !== false
    ) {
      issues.push("adapter apply receipt no-apply status must be verified without operator apply");
    }
    if (receiptHandoff?.nextAction !== "rerun_post_apply_closure") {
      issues.push("adapter apply receipt no-apply handoff nextAction must rerun closure");
    }
  }
}
const autoDeactivateReceipt = report.summary?.autoDeactivateReceipt;
if (!autoDeactivateReceipt || typeof autoDeactivateReceipt !== "object") {
  issues.push("auto-deactivate receipt summary missing");
} else {
  if (autoDeactivateReceipt.required !== true) {
    issues.push("auto-deactivate receipt requirement missing");
  }
  if (
    ![
      "missing",
      "pending_explicit_execute_receipt",
      "receipt_verified",
      "blocked_receipt_gate_incomplete",
    ].includes(autoDeactivateReceipt.status)
  ) {
    issues.push(`auto-deactivate receipt status=${autoDeactivateReceipt.status}`);
  }
  if (typeof autoDeactivateReceipt.pendingExplicitExecuteReceipt !== "boolean") {
    issues.push("auto-deactivate receipt pending flag must be boolean");
  }
  if (typeof autoDeactivateReceipt.receiptVerified !== "boolean") {
    issues.push("auto-deactivate receipt verified flag must be boolean");
  }
  if (autoDeactivateReceipt.heartbeatExecuteAllowed !== false) {
    issues.push("auto-deactivate receipt heartbeat execute must stay blocked");
  }
  if (!String(autoDeactivateReceipt.validationCommand || "").startsWith("pnpm --dir ")) {
    issues.push("auto-deactivate receipt validation command must be repo-root qualified");
  }
  if (autoDeactivateReceipt.noLiveOrderSent !== true) {
    issues.push("auto-deactivate receipt noLiveOrderSent must stay true");
  }
  if (autoDeactivateReceipt.sentOrder !== false) {
    issues.push("auto-deactivate receipt sentOrder must stay false");
  }
  if (autoDeactivateReceipt.writeBrokerOrders !== false) {
    issues.push("auto-deactivate receipt writeBrokerOrders must stay false");
  }
  if (autoDeactivateReceipt.liveTradingEnabled !== false) {
    issues.push("auto-deactivate receipt liveTradingEnabled must stay false");
  }
  if (autoDeactivateReceipt.status === "pending_explicit_execute_receipt") {
    if (autoDeactivateReceipt.pendingExplicitExecuteReceipt !== true) {
      issues.push("auto-deactivate receipt pending status flag mismatch");
    }
    if (autoDeactivateReceipt.receiptVerified !== false) {
      issues.push("auto-deactivate receipt pending must not be verified");
    }
    if (
      !dispatchWritten &&
      (!Array.isArray(report.summary?.blockers) ||
        !report.summary.blockers.includes("operator-auto-deactivate:execute-receipt-pending"))
    ) {
      issues.push("auto-deactivate receipt pending blocker missing from direct blockers");
    }
  }
}
if (!report.summary?.position?.path) {
  issues.push("verified position snapshot path missing");
}
const positionHandoff = report.summary?.position?.handoff;
if (!positionHandoff || typeof positionHandoff !== "object") {
  issues.push("position snapshot handoff summary missing");
} else {
  if (
    !["fresh", "stale_operator_refresh_required", "missing_operator_refresh_required"].includes(
      positionHandoff.status,
    )
  ) {
    issues.push(`position handoff status=${positionHandoff.status}`);
  }
  if (!["fresh", "stale"].includes(positionHandoff.freshnessStatus)) {
    issues.push(`position handoff freshness=${positionHandoff.freshnessStatus}`);
  }
  if (!positionHandoff.activeSnapshotPath) {
    issues.push("position handoff active snapshot path missing");
  }
  if (!String(positionHandoff.templatePath || "").endsWith(".template.json")) {
    issues.push("position handoff template path missing");
  }
  if (!String(positionHandoff.stagedRefreshPath || "").endsWith(".staged-refresh.json")) {
    issues.push("position handoff staged refresh path missing");
  }
  if (positionHandoff.activeSnapshotWriteSuppressed !== true) {
    issues.push("position handoff must suppress active snapshot writes");
  }
  if (positionHandoff.conversationAgentsMayWriteActiveSnapshot !== false) {
    issues.push("conversation agents must not write active snapshot");
  }
  if (
    !Array.isArray(positionHandoff.handoffChecklist) ||
    positionHandoff.handoffChecklist.length < 4
  ) {
    issues.push("position handoff checklist missing");
  }
  if (!positionHandoff.nextHandoffStep?.id) {
    issues.push("position handoff next step missing");
  }
}
if (!report.summary?.position?.verifiedAt) {
  issues.push("verified position snapshot verifiedAt missing");
}
if (!["fresh", "stale"].includes(report.summary?.position?.freshnessStatus)) {
  issues.push(`position freshnessStatus=${report.summary?.position?.freshnessStatus}`);
}
if (!Number.isFinite(Number(report.summary?.position?.verifiedAgeSeconds))) {
  issues.push("position verifiedAgeSeconds missing");
}
if (!Number.isFinite(Number(report.summary?.position?.maxFreshSeconds))) {
  issues.push("position maxFreshSeconds missing");
}
if (report.summary?.directEntryPoints?.telegram !== "sc:tr:direct") {
  issues.push("telegram direct entrypoint mismatch");
}
for (const entrypoint of ["openclaw", "codex", "claude"]) {
  const command = String(report.summary?.directEntryPoints?.[entrypoint] || "");
  if (!command.includes("capital:trade:direct")) {
    issues.push(`${entrypoint} direct command missing`);
  }
  if (!command.startsWith("pnpm --dir ")) {
    issues.push(`${entrypoint} direct command must be repo-root qualified`);
  }
}
if (report.summary?.requestedTrade?.instrument !== "A50 202605") {
  issues.push("A50 202605 requested trade missing");
}
if (report.summary?.requestedTrade?.holdingMode !== "day_trade") {
  issues.push("requested trade must be day_trade");
}
if (
  report.summary?.quote?.domesticTxFreshness === "stale" &&
  report.summary?.quote?.a50Status === "fresh"
) {
  issues.push("A50 must not be fresh when quote-status proof is stale");
}
if (
  Number.isFinite(Number(report.summary?.quote?.a50WallClockAgeSeconds)) &&
  Number(report.summary.quote.a50WallClockAgeSeconds) >
    Number(report.summary.quote.a50MaxFreshSeconds ?? 300) &&
  report.summary?.quote?.a50Status === "fresh"
) {
  issues.push("A50 must not be fresh when wall-clock quote age exceeds freshness limit");
}

if (issues.length > 0) {
  process.stderr.write(`CAPITAL_DIRECT_OPERATION_STATUS_CHECK=FAIL issues=${issues.join(";")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `CAPITAL_DIRECT_OPERATION_STATUS_CHECK=OK status=${report.status} tx=${report.summary.quote.domesticTxStatus} a50=${report.summary.quote.a50Status} position=${report.summary.position.decisionStatus} ack=${report.summary.externalBrokerAdapter.ackStatus} noLiveOrderSent=${report.summary.safety.noLiveOrderSent}\n`,
  );
}
