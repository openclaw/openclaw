#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCapitalAdapterAckOperatorApplyReceiptGate } from "./openclaw-capital-adapter-ack-operator-apply-receipt-gate.mjs";
import { buildCapitalExternalBrokerAdapterAckGate } from "./openclaw-capital-external-broker-adapter-ack-gate.mjs";
import {
  buildCapitalLiveExecutorArmProfile,
  CAPITAL_LIVE_EXECUTOR_ARM_ALLOW_DEPRECATED_FIELD,
  CAPITAL_LIVE_EXECUTOR_ARM_ALLOW_FIELD,
} from "./openclaw-capital-live-executor-arm-profile.mjs";
import { buildCapitalLiveOrderDryRunPretradeGate } from "./openclaw-capital-live-order-dry-run-pretrade-gate.mjs";
import { buildCapitalLiveReadinessGate } from "./openclaw-capital-live-readiness-gate.mjs";

const SCHEMA = "openclaw.capital.live-operator-execution-packet.v1";
const currentFile = fileURLToPath(import.meta.url);
export const CAPITAL_OPERATOR_PACKET_ARM_PROFILE_REQUIRED_ALLOW_FIELD =
  CAPITAL_LIVE_EXECUTOR_ARM_ALLOW_FIELD;
export const CAPITAL_OPERATOR_PACKET_ARM_PROFILE_DEPRECATED_ALLOW_FIELD =
  CAPITAL_LIVE_EXECUTOR_ARM_ALLOW_DEPRECATED_FIELD;
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

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function pnpmCommand(repoRoot, scriptName) {
  return `pnpm --dir ${path.resolve(repoRoot)} ${scriptName}`;
}

function qualifyPnpmCommand(repoRoot, command) {
  const value = String(command || "").trim();
  if (!value || !/^pnpm\s+/i.test(value) || /^pnpm\s+--dir\s+/i.test(value)) {
    return value;
  }
  return `pnpm --dir ${path.resolve(repoRoot)} ${value.replace(/^pnpm\s+/i, "")}`;
}

function directPretradeCoreBlockers(direct) {
  return safeArray(direct?.preTradeRiskGate?.blockers).filter(
    (item) => !DIRECT_PRETRADE_SAFETY_ONLY_BLOCKERS.has(String(item)),
  );
}

function isDirectPretradeReady(direct) {
  if (direct?.safety?.sentOrder === true) {
    return false;
  }
  if (direct?.preTradeRiskGate?.allowedToSend === true) {
    return true;
  }
  const coreBlockers = directPretradeCoreBlockers(direct);
  return (
    direct?.preTradeRiskGate?.attachedBeforeBrokerSend === true &&
    direct?.preTradeRiskGate?.evaluated === true &&
    direct?.preTradeRiskGate?.allowedToSend === false &&
    coreBlockers.length === 0
  );
}

function resolveArmProfileAllowField(armProfile) {
  const hasCanonicalKey =
    armProfile && Object.hasOwn(armProfile, CAPITAL_LIVE_EXECUTOR_ARM_ALLOW_FIELD);
  const hasDeprecatedKey =
    armProfile && Object.hasOwn(armProfile, CAPITAL_LIVE_EXECUTOR_ARM_ALLOW_DEPRECATED_FIELD);
  const canonicalValue =
    hasCanonicalKey && armProfile[CAPITAL_LIVE_EXECUTOR_ARM_ALLOW_FIELD] === true;
  const deprecatedValue =
    hasDeprecatedKey && armProfile[CAPITAL_LIVE_EXECUTOR_ARM_ALLOW_DEPRECATED_FIELD] === true;
  if (hasCanonicalKey) {
    return {
      allowBrokerWriteWhenAllGatesPass: canonicalValue,
      hasCanonicalKey,
      hasDeprecatedKey,
      usedDeprecatedAlias: false,
      contractStatus: "canonical",
      explicitFailure: false,
    };
  }
  if (hasDeprecatedKey) {
    return {
      allowBrokerWriteWhenAllGatesPass: deprecatedValue,
      hasCanonicalKey,
      hasDeprecatedKey,
      usedDeprecatedAlias: true,
      contractStatus: "deprecated_alias_only",
      explicitFailure: true,
    };
  }
  return {
    allowBrokerWriteWhenAllGatesPass: false,
    hasCanonicalKey,
    hasDeprecatedKey,
    usedDeprecatedAlias: false,
    contractStatus: "missing_required_key",
    explicitFailure: true,
  };
}

function buildBlockerPlan({
  repoRoot,
  readinessReady,
  adapterAckVerified,
  applyReceiptVerified,
  directReady,
  liveExecutorArmed,
  noLiveOrderSent,
  readiness,
  adapterAck,
  applyReceipt,
  direct,
  directCoreBlockers,
  armProfile,
}) {
  const actions = [];
  if (!applyReceiptVerified) {
    const receipt = applyReceipt.operatorReceipt ?? {};
    const receiptCommand =
      qualifyPnpmCommand(repoRoot, receipt.validationCommands?.receipt) ||
      pnpmCommand(repoRoot, "capital:trade:adapter-ack-apply-receipt:check");
    actions.push({
      order: 1,
      id: "adapter_apply_receipt",
      gate: "adapter:apply-receipt-verified",
      status: "blocked",
      blockerIds: uniqueStrings([
        "adapterAck:apply-receipt-not-verified",
        ...safeArray(applyReceipt.blockers).map((item) => `adapterApplyReceipt:${item}`),
      ]),
      validationCommand: receiptCommand,
      receiptStatus: applyReceipt.status || "",
      receiptAction: receipt.action || applyReceipt.action || "",
      operatorMayApply: receipt.operatorMayApply === true,
      operatorApplyVerified: receipt.operatorApplyVerified === true,
      alreadyAppliedVerified: receipt.alreadyAppliedVerified === true,
      activeState: receipt.activeState || "",
      sourcePath: receipt.sourcePath || "",
      destinationPath: receipt.destinationPath || "",
      backupPath: receipt.backupPath || "",
      tempPath: receipt.tempPath || "",
      currentContentSha256: receipt.currentContentSha256 || "",
      candidateContentSha256: receipt.candidateContentSha256 || "",
      reportPath: applyReceipt.paths?.reportPath || "",
      nextSafeTask: applyReceipt.nextSafeTask || "",
      operatorAction:
        receipt.operatorMayApply === true
          ? "operator-owned adapter must apply the staged ack to the active ack, then rerun the adapter apply receipt gate"
          : "operator-owned adapter must verify the adapter apply receipt before operator execution can be considered ready",
    });
  }
  if (!adapterAckVerified) {
    const refreshPlan = adapterAck.operatorReview?.refreshPlan ?? {};
    const adapterAckCheckCommand = pnpmCommand(repoRoot, "capital:trade:adapter-ack:check");
    const liveReadinessCheckCommand = pnpmCommand(repoRoot, "capital:live-readiness:check");
    actions.push({
      order: 2,
      id: "adapter_ack_hash",
      gate: "adapter:ack-usable",
      status: "blocked",
      blockerIds: uniqueStrings([
        "adapterAck:not-verified",
        ...safeArray(adapterAck.blockers).map((item) => `adapterAck:${item}`),
      ]),
      validationCommand: adapterAckCheckCommand,
      expectedSealedIntentSha256:
        adapterAck.ack?.sealedIntentHash?.expected ||
        adapterAck.ack?.expectedValue?.sealedIntentSha256 ||
        adapterAck.sealedIntentSha256 ||
        "",
      actualSealedIntentSha256:
        adapterAck.ack?.sealedIntentHash?.actual ||
        adapterAck.ack?.currentValue?.sealedIntentSha256 ||
        "",
      requiredTemplatePath:
        adapterAck.ack?.sealedIntentHash?.requiredTemplatePath ||
        adapterAck.ack?.requiredTemplatePath ||
        "",
      stagedCandidateAckPath:
        adapterAck.operatorReview?.stagedCandidateAckPath ||
        adapterAck.paths?.stagedCandidateAckPath ||
        "",
      activeAckPath: adapterAck.operatorReview?.activeAckPath || adapterAck.ack?.activePath || "",
      activeAckWriteSuppressed: adapterAck.operatorReview?.activeAckWriteSuppressed === true,
      allowedWriter: adapterAck.operatorReview?.allowedWriter || "",
      refreshPlan: {
        status: refreshPlan.status || "",
        reason: refreshPlan.reason || "",
        sourcePath:
          refreshPlan.sourcePath || adapterAck.operatorReview?.stagedCandidateAckPath || "",
        destinationPath:
          refreshPlan.destinationPath || adapterAck.operatorReview?.activeAckPath || "",
        candidateRollbackVerifiedAt:
          refreshPlan.candidateRollbackVerifiedAt || adapterAck.ack?.rollbackVerifiedAt || "",
        safeToPromoteCandidate: refreshPlan.safeToPromoteCandidate === true,
        validationCommand:
          qualifyPnpmCommand(repoRoot, refreshPlan.validationCommand) || adapterAckCheckCommand,
        postRefreshValidationCommand:
          qualifyPnpmCommand(repoRoot, refreshPlan.postRefreshValidationCommand) ||
          liveReadinessCheckCommand,
        allowedWriter: refreshPlan.allowedWriter || adapterAck.operatorReview?.allowedWriter || "",
      },
      operatorAction: adapterAck.operatorReview?.candidateAck?.sealedIntentSha256
        ? "operator-owned adapter must review staged candidate ack, then write active ack only from adapter runtime after canary and rollback verification"
        : adapterAck.ack?.sealedIntentHash?.operatorAction ||
          "operator-owned adapter must refresh active ack from required-current template after canary and rollback verification",
    });
  }
  if (!liveExecutorArmed) {
    actions.push({
      order: 3,
      id: "live_executor_arm_profile",
      gate: "executor:arm-profile-armed",
      status: "blocked",
      blockerIds: uniqueStrings([
        "liveExecutor:arm-profile-not-armed",
        ...safeArray(armProfile.blockers).map((item) => `liveExecutor:${item}`),
      ]),
      validationCommand: pnpmCommand(repoRoot, "capital:trade:live-executor-profile:check"),
      profilePath: armProfile.profilePath || armProfile.paths?.profilePath || "",
      templatePath: armProfile.templatePath || armProfile.paths?.templatePath || "",
      stagedRearmProfilePath:
        armProfile.operatorReview?.stagedRearmProfilePath ||
        armProfile.paths?.stagedRearmProfilePath ||
        "",
      activeProfileWriteSuppressed:
        armProfile.operatorReview?.activeProfileWriteSuppressed === true,
      allowedWriter: armProfile.operatorReview?.allowedWriter || "",
      expiresAt: armProfile.expiresAt || "",
      operatorAction:
        "operator-managed local broker executor must be re-armed with max 15 minute TTL after ack and live gates are current",
    });
  }
  if (!directReady) {
    actions.push({
      order: 4,
      id: "direct_pretrade_clear",
      gate: "direct:pretrade-allowed",
      status: "blocked",
      blockerIds: uniqueStrings([
        "direct:pretrade-not-ready",
        ...directCoreBlockers.map((item) => `direct:${item}`),
      ]),
      validationCommand: pnpmCommand(repoRoot, "capital:live-order-dry-run"),
      directStatus: direct.status || "",
      allowedToSend: direct.preTradeRiskGate?.allowedToSend === true,
      coreBlockers: directCoreBlockers,
      sentOrder: direct.safety?.sentOrder === true,
      operatorAction:
        "direct pretrade may clear only after broker-write authority belongs to the approved local executor and no conversation agent writes broker orders",
    });
  }
  if (!readinessReady) {
    actions.push({
      order: 5,
      id: "readiness_aggregation",
      gate: "readiness:ready-for-operator-review",
      status: "blocked",
      blockerIds: uniqueStrings([
        "readiness:not-ready",
        ...safeArray(readiness.blockers).map((item) => `readiness:${item}`),
      ]),
      validationCommand: pnpmCommand(repoRoot, "capital:live-readiness:check"),
      readinessStatus: readiness.status || "",
      operatorAction:
        "rerun live readiness only after adapter ack, direct pretrade, and executor arm evidence are current",
    });
  }
  if (!noLiveOrderSent) {
    actions.push({
      order: 99,
      id: "safety_live_order_already_sent",
      gate: "safety:no-live-order-sent",
      status: "blocked",
      blockerIds: ["safety:live-order-already-sent"],
      validationCommand: pnpmCommand(repoRoot, "capital:live-readiness:check"),
      operatorAction: "stop and reconcile broker/order reports before any further packet review",
    });
  }
  const orderedActions = actions.sort((left, right) => left.order - right.order);
  return {
    status: orderedActions.length === 0 ? "clear" : "blocked",
    orderedActionCount: orderedActions.length,
    nextAction: orderedActions[0]?.id || "none_required",
    orderedActions,
    validationCommands: uniqueStrings(orderedActions.map((action) => action.validationCommand)),
  };
}

function renderMarkdown(report) {
  return [
    "# Capital Live Operator Execution Packet",
    "",
    `status: ${report.status}`,
    `sealedIntentSha256: ${report.sealedIntentSha256}`,
    `readiness: ${report.readiness.status}`,
    `adapterAck: ${report.adapterAck.status}`,
    `operatorCanExecute: ${report.operatorCanExecute}`,
    `machineLine: ${report.machineLine}`,
    "",
    "## Broker Payload",
    "",
    `- api: ${report.executionPayload.brokerApi || "missing"}`,
    `- symbol: ${report.executionPayload.commandPayload?.stockNo || "missing"}`,
    `- dayTradeMode: ${report.executionPayload.commandPayload?.dayTradeMode || "missing"}`,
    "",
    "## Blockers",
    ...(report.blockers.length > 0 ? report.blockers.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Blocker Plan",
    `- nextAction: ${report.blockerPlan.nextAction}`,
    ...report.blockerPlan.orderedActions.map(
      (item) => `- ${item.order}. ${item.id}: ${item.validationCommand}`,
    ),
    "",
    `nextSafeTask: ${report.nextSafeTask}`,
    "",
  ].join("\n");
}

export function buildCapitalLiveOperatorExecutionPacketReport(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const tradingRoot = path.join(repoRoot, ".openclaw", "trading");
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const readiness = options.readiness ?? {};
  const adapterAck = options.adapterAck ?? {};
  const applyReceipt = options.applyReceipt ?? {};
  const direct = options.direct ?? {};
  const armProfile = options.armProfile ?? readiness.readiness?.liveExecutorArmProfile ?? {};
  const sealedIntent =
    direct.operatorHandoff?.handoffPacket?.sealedOrderIntent ??
    direct.operatorHandoff?.handoffPacket?.sealedIntent ??
    {};
  const commandPayload =
    direct.operatorHandoff?.handoffPacket?.commandPayload ?? sealedIntent.commandPayload ?? {};
  const brokerFields =
    direct.operatorHandoff?.handoffPacket?.brokerFields ?? sealedIntent.brokerFields ?? {};
  const stops = direct.operatorHandoff?.handoffPacket?.stops ?? sealedIntent.stops ?? {};
  const readinessReady = readiness.status === "ready_for_operator_adapter_review";
  const adapterAckVerified = adapterAck.status === "verified";
  const receipt = applyReceipt.operatorReceipt ?? {};
  const applyReceiptAppliedVerified =
    applyReceipt.status === "applied_receipt_verified" &&
    receipt.operatorApplyVerified === true &&
    receipt.alreadyAppliedVerified === true &&
    receipt.activeState === "applied_candidate_matches";
  const applyReceiptNoApplyRequiredVerified =
    applyReceipt.status === "no_apply_required" &&
    receipt.noApplyRequired === true &&
    receipt.operatorMayApply !== true &&
    receipt.operatorApplyVerified !== true &&
    receipt.activeState === "pre_apply_current_matches";
  const applyReceiptVerified = applyReceiptAppliedVerified || applyReceiptNoApplyRequiredVerified;
  const directCoreBlockers = directPretradeCoreBlockers(direct);
  const directReady = isDirectPretradeReady(direct);
  const armProfileAllowField = resolveArmProfileAllowField(armProfile);
  const armProfileAllowBrokerWriteWhenAllGatesPass =
    armProfileAllowField.allowBrokerWriteWhenAllGatesPass === true;
  const liveExecutorArmed =
    armProfile.status === "armed" &&
    armProfileAllowBrokerWriteWhenAllGatesPass &&
    armProfileAllowField.explicitFailure !== true;
  const noLiveOrderSent =
    readiness.safety?.sentOrder !== true &&
    direct.safety?.sentOrder !== true &&
    adapterAck.safety?.sentOrder !== true &&
    applyReceipt.safety?.sentOrder !== true &&
    receipt.safety?.sentOrder !== true &&
    armProfile.sentOrder !== true;
  const operatorCanExecute =
    readinessReady &&
    adapterAckVerified &&
    applyReceiptVerified &&
    directReady &&
    liveExecutorArmed &&
    noLiveOrderSent;
  const blockers = operatorCanExecute
    ? []
    : [
        ...(readinessReady ? [] : ["readiness:not-ready"]),
        ...(adapterAckVerified ? [] : ["adapterAck:not-verified"]),
        ...(applyReceiptVerified ? [] : ["adapterAck:apply-receipt-not-verified"]),
        ...(directReady ? [] : ["direct:pretrade-not-ready"]),
        ...(liveExecutorArmed ? [] : ["liveExecutor:arm-profile-not-armed"]),
        ...(armProfileAllowField.explicitFailure
          ? [`liveExecutor:arm-profile-field-contract-${armProfileAllowField.contractStatus}`]
          : []),
        ...(noLiveOrderSent ? [] : ["safety:live-order-already-sent"]),
        ...safeArray(readiness.blockers).map((item) => `readiness:${item}`),
        ...safeArray(adapterAck.blockers).map((item) => `adapterAck:${item}`),
        ...safeArray(applyReceipt.blockers).map((item) => `adapterApplyReceipt:${item}`),
        ...(directReady ? [] : directCoreBlockers.map((item) => `direct:${item}`)),
        ...safeArray(armProfile.blockers).map((item) => `liveExecutor:${item}`),
      ];
  const blockerPlan = buildBlockerPlan({
    repoRoot,
    readinessReady,
    adapterAckVerified,
    applyReceiptVerified,
    directReady,
    directCoreBlockers,
    liveExecutorArmed,
    noLiveOrderSent,
    readiness,
    adapterAck,
    applyReceipt,
    direct,
    armProfile,
  });
  const status = operatorCanExecute ? "operator_adapter_execution_ready" : "blocked";
  const sealedIntentSha256 =
    readiness.sealedOrderIntentSha256 ||
    adapterAck.sealedIntentSha256 ||
    sealedIntent.sha256 ||
    adapterAck.ack?.expectedValue?.sealedIntentSha256 ||
    "";
  const adapterAckRefreshPlan = adapterAck.operatorReview?.refreshPlan ?? {};
  const reportPath = path.join(
    stateRoot,
    "openclaw-capital-live-operator-execution-packet-latest.json",
  );
  const markdownPath = path.join(
    stateRoot,
    "openclaw-capital-live-operator-execution-packet-latest.md",
  );
  const packetPath = path.join(tradingRoot, "capital-live-operator-execution-packet.json");
  const machineLine = [
    `capitalOperatorPacket=${status}`,
    `sha256=${sealedIntentSha256 || "missing"}`,
    `readiness=${readiness.status || "missing"}`,
    `adapterAck=${adapterAck.status || "missing"}`,
    `adapterHashOk=${adapterAck.ack?.hashOk === true}`,
    `adapterCanarySentOrder=${adapterAck.ack?.canarySentOrder === true}`,
    `adapterRollbackFresh=${adapterAck.ack?.rollbackFresh === true}`,
    `adapterApplyReceipt=${applyReceipt.status || "missing"}`,
    `adapterApplyReceiptVerified=${applyReceiptVerified}`,
    `executorArm=${armProfile.status || "missing"}`,
    `armAllowField=${armProfileAllowField.contractStatus}`,
    `executorArmed=${liveExecutorArmed}`,
    `operatorCanExecute=${operatorCanExecute}`,
    `nextAction=${blockerPlan.nextAction}`,
    "noOrderWrite=true",
    "sentOrder=false",
    `blockers=${blockers.length}`,
  ].join(" ");

  return {
    schema: SCHEMA,
    generatedAt,
    status,
    mode: "external_operator_owned_adapter_packet",
    sealedIntentSha256,
    operatorCanExecute,
    machineLine,
    readiness: {
      status: readiness.status || "",
      machineLine: readiness.machineLine || "",
      blockers: safeArray(readiness.blockers),
    },
    liveExecutorArmProfile: {
      status: armProfile.status || "",
      armed: armProfile.armed === true,
      allowBrokerWriteWhenAllGatesPass: armProfileAllowBrokerWriteWhenAllGatesPass,
      // @deprecated: keep one-version compatibility for downstream readers.
      allowExecutorWrite: armProfileAllowBrokerWriteWhenAllGatesPass,
      allowFieldContract: {
        requiredKey: CAPITAL_LIVE_EXECUTOR_ARM_ALLOW_FIELD,
        deprecatedKey: CAPITAL_LIVE_EXECUTOR_ARM_ALLOW_DEPRECATED_FIELD,
        status: armProfileAllowField.contractStatus,
        hasRequiredKey: armProfileAllowField.hasCanonicalKey,
        hasDeprecatedKey: armProfileAllowField.hasDeprecatedKey,
        deprecatedAliasUsed: armProfileAllowField.usedDeprecatedAlias,
        explicitFailure: armProfileAllowField.explicitFailure,
      },
      brokerWriteAuthorityTarget: armProfile.brokerWriteAuthorityTarget || "",
      expiresAt: armProfile.expiresAt || "",
      profilePath: armProfile.profilePath || armProfile.paths?.profilePath || "",
      templatePath: armProfile.templatePath || armProfile.paths?.templatePath || "",
      stagedRearmProfilePath:
        armProfile.operatorReview?.stagedRearmProfilePath ||
        armProfile.paths?.stagedRearmProfilePath ||
        "",
      operatorReviewStatus: armProfile.operatorReview?.status || "",
      activeProfileWriteSuppressed:
        armProfile.operatorReview?.activeProfileWriteSuppressed === true,
      allowedWriter: armProfile.operatorReview?.allowedWriter || "",
      blockers: safeArray(armProfile.blockers),
    },
    adapterAck: {
      status: adapterAck.status || "",
      machineLine: adapterAck.machineLine || "",
      hashOk: adapterAck.ack?.hashOk === true,
      canaryPass: adapterAck.ack?.canaryPass === true,
      canaryDryRun: adapterAck.ack?.canaryDryRun === true,
      canarySentOrder: adapterAck.ack?.canarySentOrder === true,
      rollbackPass: adapterAck.ack?.rollbackPass === true,
      rollbackVerifiedAt: adapterAck.ack?.rollbackVerifiedAt || "",
      rollbackAgeSeconds: adapterAck.ack?.rollbackAgeSeconds ?? null,
      rollbackMaxFreshSeconds: adapterAck.ack?.rollbackMaxFreshSeconds ?? null,
      rollbackFresh: adapterAck.ack?.rollbackFresh === true,
      rollbackFreshnessStatus: adapterAck.ack?.rollbackFreshnessStatus || "unknown",
      expectedSealedIntentSha256: adapterAck.ack?.expectedValue?.sealedIntentSha256 || "",
      actualSealedIntentSha256: adapterAck.ack?.currentValue?.sealedIntentSha256 || "",
      requiredTemplatePath: adapterAck.ack?.requiredTemplatePath || "",
      stagedCandidateAckPath:
        adapterAck.operatorReview?.stagedCandidateAckPath ||
        adapterAck.paths?.stagedCandidateAckPath ||
        "",
      activeAckPath: adapterAck.operatorReview?.activeAckPath || adapterAck.ack?.activePath || "",
      operatorReviewStatus: adapterAck.operatorReview?.status || "",
      activeAckWriteSuppressed: adapterAck.operatorReview?.activeAckWriteSuppressed === true,
      allowedWriter: adapterAck.operatorReview?.allowedWriter || "",
      stagedCandidateSealedIntentSha256:
        adapterAck.operatorReview?.candidateAck?.sealedIntentSha256 || "",
      refreshPlan: {
        status: adapterAckRefreshPlan.status || "",
        reason: adapterAckRefreshPlan.reason || "",
        sourcePath: adapterAckRefreshPlan.sourcePath || "",
        destinationPath: adapterAckRefreshPlan.destinationPath || "",
        expectedSealedIntentSha256: adapterAckRefreshPlan.expectedSealedIntentSha256 || "",
        actualSealedIntentSha256: adapterAckRefreshPlan.actualSealedIntentSha256 || "",
        candidateSealedIntentSha256: adapterAckRefreshPlan.candidateSealedIntentSha256 || "",
        candidateRollbackVerifiedAt:
          adapterAckRefreshPlan.candidateRollbackVerifiedAt ||
          adapterAck.ack?.rollbackVerifiedAt ||
          "",
        safeToPromoteCandidate: adapterAckRefreshPlan.safeToPromoteCandidate === true,
        activeAckWriteSuppressed: adapterAckRefreshPlan.activeAckWriteSuppressed === true,
        conversationAgentsMayWriteActiveAck:
          adapterAckRefreshPlan.conversationAgentsMayWriteActiveAck === true,
        allowedWriter: adapterAckRefreshPlan.allowedWriter || "",
        validationCommand: qualifyPnpmCommand(repoRoot, adapterAckRefreshPlan.validationCommand),
        postRefreshValidationCommand: qualifyPnpmCommand(
          repoRoot,
          adapterAckRefreshPlan.postRefreshValidationCommand,
        ),
      },
      applyReceipt: {
        status: applyReceipt.status || "",
        verified: applyReceiptVerified,
        action: receipt.action || applyReceipt.action || "",
        operatorMayApply: receipt.operatorMayApply === true,
        operatorApplyVerified: receipt.operatorApplyVerified === true,
        alreadyAppliedVerified: receipt.alreadyAppliedVerified === true,
        noApplyRequired: receipt.noApplyRequired === true,
        activeState: receipt.activeState || "",
        sourcePath: receipt.sourcePath || "",
        destinationPath: receipt.destinationPath || "",
        backupPath: receipt.backupPath || "",
        tempPath: receipt.tempPath || "",
        currentContentSha256: receipt.currentContentSha256 || "",
        candidateContentSha256: receipt.candidateContentSha256 || "",
        validationCommand:
          qualifyPnpmCommand(repoRoot, receipt.validationCommands?.receipt) ||
          pnpmCommand(repoRoot, "capital:trade:adapter-ack-apply-receipt:check"),
        reportPath: applyReceipt.paths?.reportPath || "",
        nextSafeTask: applyReceipt.nextSafeTask || "",
      },
    },
    blockerPlan,
    executionPayload: {
      destination: "external_operator_owned_broker_adapter",
      liveExecutorDestination: "openclaw_managed_local_broker_executor",
      liveExecutorArmed,
      brokerApi: direct.liveOrderDraft?.brokerApi || sealedIntent.brokerApi || "",
      brokerStruct: direct.liveOrderDraft?.brokerStruct || sealedIntent.brokerStruct || "",
      sealedOrderIntent: sealedIntent,
      commandPayload,
      brokerFields,
      stops,
      dispatchPolicy: operatorCanExecute
        ? "operator_adapter_may_execute_after_own_final_confirmation"
        : "blocked_do_not_send",
    },
    blockers: [...new Set(blockers)],
    safety: {
      generatedPacketOnly: true,
      wroteBrokerCommand: false,
      brokerWriteAttempted: false,
      writeBrokerOrders: false,
      liveTradingEnabled: false,
      codexBrokerWriteAllowed: false,
      claudeBrokerWriteAllowed: false,
      openclawBrokerWriteAllowed: false,
      telegramBrokerWriteAllowed: false,
      requiresExternalOperatorOwnedAdapter: true,
      localBrokerExecutorArmed: liveExecutorArmed,
      localBrokerExecutorWriteAllowedAfterGates: operatorCanExecute,
      containsCredentials: false,
      sentOrder: false,
      noLiveOrderSent: true,
      no_live_order_sent: true,
    },
    paths: {
      reportPath,
      markdownPath,
      packetPath,
      readinessReportPath: readiness.paths?.reportPath || "",
      adapterAckReportPath: adapterAck.paths?.reportPath || "",
      adapterAckApplyReceiptReportPath: applyReceipt.paths?.reportPath || "",
      directReportPath: direct.scope?.statePath || "",
    },
    nextSafeTask: operatorCanExecute
      ? "Local broker executor arm profile and all live gates are ready; run executor-owned final confirmation outside conversation agents."
      : !applyReceiptVerified
        ? "先由 operator-owned adapter 完成 adapter ack apply receipt，再重跑 pnpm capital:trade:operator-packet:check。"
        : "先讓 readiness、adapter ack、direct pretrade、live executor arm profile 全部通過；再重跑 pnpm capital:trade:operator-packet:check。",
  };
}

export async function buildCapitalLiveOperatorExecutionPacket(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const [readiness, adapterAck, applyReceipt, direct, armProfile] = await Promise.all([
    buildCapitalLiveReadinessGate({ repoRoot }),
    buildCapitalExternalBrokerAdapterAckGate({ repoRoot }),
    buildCapitalAdapterAckOperatorApplyReceiptGate({ repoRoot }),
    buildCapitalLiveOrderDryRunPretradeGate({ repoRoot }),
    buildCapitalLiveExecutorArmProfile({ repoRoot }),
  ]);
  return buildCapitalLiveOperatorExecutionPacketReport({
    repoRoot,
    readiness,
    adapterAck,
    applyReceipt,
    direct,
    armProfile,
  });
}

async function main() {
  const report = await buildCapitalLiveOperatorExecutionPacket({ repoRoot: process.cwd() });
  if (hasFlag("--write-state") || hasFlag("--check")) {
    await writeJsonWithSha(report.paths.reportPath, report);
    await writeJsonWithSha(report.paths.packetPath, report);
    await writeTextWithSha(report.paths.markdownPath, renderMarkdown(report));
  }
  if (hasFlag("--json") || hasFlag("--check")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${report.machineLine}\n`);
  }
}

if (process.argv[1] === currentFile) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
