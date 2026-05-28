#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-operator-execution-packet-latest.json",
);
const ALLOWED_STATUSES = new Set(["blocked", "operator_adapter_execution_ready"]);

const report = JSON.parse(await fs.readFile(REPORT_PATH, "utf8"));

function assertRepoRootPnpmCommand(command, fieldName) {
  assert.match(
    String(command || ""),
    /^pnpm --dir .+ /,
    `${fieldName} must be repo-root qualified`,
  );
}

assert.equal(report.schema, "openclaw.capital.live-operator-execution-packet.v1");
assert.ok(ALLOWED_STATUSES.has(report.status), `status=${report.status}`);
assert.equal(typeof report.sealedIntentSha256, "string");
assert.notEqual(report.sealedIntentSha256.length, 0);
assert.equal(typeof report.operatorCanExecute, "boolean");
assert.equal(report.executionPayload?.destination, "external_operator_owned_broker_adapter");
assert.equal(
  report.executionPayload?.liveExecutorDestination,
  "openclaw_managed_local_broker_executor",
);
assert.equal(typeof report.executionPayload?.liveExecutorArmed, "boolean");
assert.ok(
  ["blocked_do_not_send", "operator_adapter_may_execute_after_own_final_confirmation"].includes(
    report.executionPayload?.dispatchPolicy,
  ),
);
assert.equal(report.safety?.generatedPacketOnly, true);
assert.equal(report.safety?.wroteBrokerCommand, false);
assert.equal(report.safety?.brokerWriteAttempted, false);
assert.equal(report.safety?.writeBrokerOrders, false);
assert.equal(report.safety?.liveTradingEnabled, false);
assert.equal(report.safety?.codexBrokerWriteAllowed, false);
assert.equal(report.safety?.claudeBrokerWriteAllowed, false);
assert.equal(report.safety?.openclawBrokerWriteAllowed, false);
assert.equal(report.safety?.telegramBrokerWriteAllowed, false);
assert.equal(report.safety?.requiresExternalOperatorOwnedAdapter, true);
assert.equal(typeof report.safety?.localBrokerExecutorArmed, "boolean");
assert.equal(typeof report.safety?.localBrokerExecutorWriteAllowedAfterGates, "boolean");
assert.equal(report.safety?.containsCredentials, false);
assert.equal(report.safety?.sentOrder, false);
assert.equal(report.safety?.noLiveOrderSent, true);
assert.equal(report.safety?.no_live_order_sent, true);
assert.match(report.machineLine, /capitalOperatorPacket=/);
assert.match(report.machineLine, /operatorCanExecute=/);
assert.match(report.machineLine, /nextAction=/);
assert.match(report.machineLine, /adapterHashOk=/);
assert.match(report.machineLine, /adapterCanarySentOrder=/);
assert.match(report.machineLine, /adapterRollbackFresh=/);
assert.match(report.machineLine, /adapterApplyReceipt=/);
assert.match(report.machineLine, /adapterApplyReceiptVerified=/);
assert.match(report.machineLine, /executorArm=/);
assert.match(report.machineLine, /executorArmed=/);
assert.match(report.machineLine, /noOrderWrite=true/);
assert.match(report.machineLine, /sentOrder=false/);
assert.equal(typeof report.liveExecutorArmProfile?.status, "string");
assert.equal(typeof report.liveExecutorArmProfile?.armed, "boolean");
assert.equal(typeof report.liveExecutorArmProfile?.allowBrokerWriteWhenAllGatesPass, "boolean");
assert.equal(typeof report.liveExecutorArmProfile?.allowFieldContract?.requiredKey, "string");
assert.equal(typeof report.liveExecutorArmProfile?.allowFieldContract?.deprecatedKey, "string");
assert.equal(typeof report.liveExecutorArmProfile?.allowFieldContract?.status, "string");
assert.equal(typeof report.liveExecutorArmProfile?.allowFieldContract?.hasRequiredKey, "boolean");
assert.equal(typeof report.liveExecutorArmProfile?.allowFieldContract?.hasDeprecatedKey, "boolean");
assert.equal(
  typeof report.liveExecutorArmProfile?.allowFieldContract?.deprecatedAliasUsed,
  "boolean",
);
assert.equal(typeof report.liveExecutorArmProfile?.allowFieldContract?.explicitFailure, "boolean");
assert.equal(typeof report.liveExecutorArmProfile?.allowExecutorWrite, "boolean");
assert.equal(typeof report.liveExecutorArmProfile?.stagedRearmProfilePath, "string");
assert.equal(typeof report.liveExecutorArmProfile?.operatorReviewStatus, "string");
assert.equal(typeof report.liveExecutorArmProfile?.activeProfileWriteSuppressed, "boolean");
assert.equal(typeof report.liveExecutorArmProfile?.allowedWriter, "string");
assert.equal(typeof report.adapterAck?.hashOk, "boolean");
assert.equal(typeof report.adapterAck?.canaryDryRun, "boolean");
assert.equal(typeof report.adapterAck?.canarySentOrder, "boolean");
assert.equal(typeof report.adapterAck?.rollbackFresh, "boolean");
assert.ok(
  ["fresh", "stale", "unknown"].includes(report.adapterAck?.rollbackFreshnessStatus),
  `rollbackFreshnessStatus=${report.adapterAck?.rollbackFreshnessStatus}`,
);
if (report.adapterAck?.rollbackVerifiedAt) {
  assert.equal(typeof report.adapterAck?.rollbackAgeSeconds, "number");
}
assert.equal(report.adapterAck?.expectedSealedIntentSha256, report.sealedIntentSha256);
assert.equal(typeof report.adapterAck?.actualSealedIntentSha256, "string");
assert.equal(typeof report.adapterAck?.stagedCandidateAckPath, "string");
assert.equal(typeof report.adapterAck?.activeAckPath, "string");
assert.equal(typeof report.adapterAck?.operatorReviewStatus, "string");
assert.equal(typeof report.adapterAck?.activeAckWriteSuppressed, "boolean");
assert.equal(typeof report.adapterAck?.allowedWriter, "string");
assert.equal(typeof report.adapterAck?.stagedCandidateSealedIntentSha256, "string");
assert.equal(typeof report.adapterAck?.refreshPlan?.status, "string");
assert.equal(typeof report.adapterAck?.refreshPlan?.reason, "string");
assert.equal(typeof report.adapterAck?.refreshPlan?.sourcePath, "string");
assert.equal(typeof report.adapterAck?.refreshPlan?.destinationPath, "string");
assert.equal(typeof report.adapterAck?.refreshPlan?.candidateRollbackVerifiedAt, "string");
assert.equal(typeof report.adapterAck?.refreshPlan?.safeToPromoteCandidate, "boolean");
assert.equal(typeof report.adapterAck?.refreshPlan?.activeAckWriteSuppressed, "boolean");
assert.equal(typeof report.adapterAck?.refreshPlan?.conversationAgentsMayWriteActiveAck, "boolean");
assert.equal(typeof report.adapterAck?.refreshPlan?.allowedWriter, "string");
assert.equal(typeof report.adapterAck?.refreshPlan?.validationCommand, "string");
assert.equal(typeof report.adapterAck?.refreshPlan?.postRefreshValidationCommand, "string");
if (report.adapterAck?.refreshPlan?.validationCommand) {
  assertRepoRootPnpmCommand(
    report.adapterAck.refreshPlan.validationCommand,
    "adapterAck.refreshPlan.validationCommand",
  );
}
if (report.adapterAck?.refreshPlan?.postRefreshValidationCommand) {
  assertRepoRootPnpmCommand(
    report.adapterAck.refreshPlan.postRefreshValidationCommand,
    "adapterAck.refreshPlan.postRefreshValidationCommand",
  );
}
assert.equal(typeof report.adapterAck?.applyReceipt?.status, "string");
assert.equal(typeof report.adapterAck?.applyReceipt?.verified, "boolean");
assert.equal(typeof report.adapterAck?.applyReceipt?.action, "string");
assert.equal(typeof report.adapterAck?.applyReceipt?.operatorMayApply, "boolean");
assert.equal(typeof report.adapterAck?.applyReceipt?.operatorApplyVerified, "boolean");
assert.equal(typeof report.adapterAck?.applyReceipt?.alreadyAppliedVerified, "boolean");
assert.equal(typeof report.adapterAck?.applyReceipt?.noApplyRequired, "boolean");
assert.equal(typeof report.adapterAck?.applyReceipt?.activeState, "string");
assert.equal(typeof report.adapterAck?.applyReceipt?.sourcePath, "string");
assert.equal(typeof report.adapterAck?.applyReceipt?.destinationPath, "string");
assert.equal(typeof report.adapterAck?.applyReceipt?.validationCommand, "string");
assert.equal(typeof report.adapterAck?.applyReceipt?.reportPath, "string");
assert.equal(typeof report.adapterAck?.applyReceipt?.nextSafeTask, "string");
assertRepoRootPnpmCommand(
  report.adapterAck.applyReceipt.validationCommand,
  "adapterAck.applyReceipt.validationCommand",
);
assert.ok(["blocked", "clear"].includes(report.blockerPlan?.status));
assert.equal(typeof report.blockerPlan?.orderedActionCount, "number");
assert.equal(typeof report.blockerPlan?.nextAction, "string");
assert.ok(Array.isArray(report.blockerPlan?.orderedActions));
assert.ok(Array.isArray(report.blockerPlan?.validationCommands));
for (const action of report.blockerPlan.orderedActions) {
  assert.equal(typeof action.order, "number");
  assert.equal(typeof action.id, "string");
  assert.equal(typeof action.gate, "string");
  assert.equal(typeof action.validationCommand, "string");
  assertRepoRootPnpmCommand(action.validationCommand, `blockerPlan.${action.id}.validationCommand`);
  assert.equal(typeof action.operatorAction, "string");
  assert.ok(Array.isArray(action.blockerIds));
}

if (report.adapterAck.hashOk === false && report.adapterAck.actualSealedIntentSha256) {
  assert.notEqual(
    report.adapterAck.actualSealedIntentSha256,
    report.adapterAck.expectedSealedIntentSha256,
  );
  assert.notEqual(report.adapterAck.stagedCandidateAckPath, report.adapterAck.activeAckPath);
  assert.equal(report.adapterAck.activeAckWriteSuppressed, true);
  assert.equal(report.adapterAck.refreshPlan.status, "operator_refresh_required");
  assert.equal(report.adapterAck.refreshPlan.reason, "active_ack_hash_mismatch");
  assert.equal(report.adapterAck.refreshPlan.sourcePath, report.adapterAck.stagedCandidateAckPath);
  assert.equal(report.adapterAck.refreshPlan.destinationPath, report.adapterAck.activeAckPath);
  assert.equal(report.adapterAck.refreshPlan.safeToPromoteCandidate, true);
  assert.notEqual(report.adapterAck.refreshPlan.candidateRollbackVerifiedAt, "ISO-8601");
  assert.match(
    report.adapterAck.refreshPlan.candidateRollbackVerifiedAt,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
  );
  const adapterAckAction = report.blockerPlan.orderedActions.find(
    (action) => action.id === "adapter_ack_hash",
  );
  assert.equal(adapterAckAction?.refreshPlan?.status, "operator_refresh_required");
  assert.equal(adapterAckAction?.refreshPlan?.safeToPromoteCandidate, true);
  assert.equal(
    adapterAckAction?.refreshPlan?.candidateRollbackVerifiedAt,
    report.adapterAck.refreshPlan.candidateRollbackVerifiedAt,
  );
  assertRepoRootPnpmCommand(
    adapterAckAction?.refreshPlan?.validationCommand,
    "adapterAckAction.refreshPlan.validationCommand",
  );
  assertRepoRootPnpmCommand(
    adapterAckAction?.refreshPlan?.postRefreshValidationCommand,
    "adapterAckAction.refreshPlan.postRefreshValidationCommand",
  );
}

if (report.adapterAck.applyReceipt.verified !== true) {
  assert.ok(report.blockers.includes("adapterAck:apply-receipt-not-verified"));
  const receiptAction = report.blockerPlan.orderedActions.find(
    (action) => action.id === "adapter_apply_receipt",
  );
  assert.equal(receiptAction?.gate, "adapter:apply-receipt-verified");
  assertRepoRootPnpmCommand(
    receiptAction?.validationCommand,
    "adapterApplyReceiptAction.validationCommand",
  );
  assert.equal(typeof receiptAction?.operatorMayApply, "boolean");
  assert.equal(typeof receiptAction?.operatorApplyVerified, "boolean");
}

if (report.status === "operator_adapter_execution_ready") {
  assert.equal(report.operatorCanExecute, true);
  assert.equal(report.blockers.length, 0);
  assert.equal(report.readiness.status, "ready_for_operator_adapter_review");
  assert.equal(report.adapterAck.status, "verified");
  assert.ok(
    ["applied_receipt_verified", "no_apply_required"].includes(
      report.adapterAck.applyReceipt.status,
    ),
  );
  assert.equal(report.adapterAck.applyReceipt.verified, true);
  if (report.adapterAck.applyReceipt.status === "no_apply_required") {
    assert.equal(report.adapterAck.applyReceipt.noApplyRequired, true);
    assert.equal(report.adapterAck.applyReceipt.operatorApplyVerified, false);
    assert.equal(report.adapterAck.applyReceipt.alreadyAppliedVerified, false);
    assert.equal(report.adapterAck.applyReceipt.activeState, "pre_apply_current_matches");
  }
  assert.equal(report.liveExecutorArmProfile.status, "armed");
  assert.equal(report.liveExecutorArmProfile.allowFieldContract.status, "canonical");
  assert.equal(report.liveExecutorArmProfile.allowFieldContract.explicitFailure, false);
  assert.equal(report.liveExecutorArmProfile.allowFieldContract.hasRequiredKey, true);
  assert.equal(report.liveExecutorArmProfile.allowBrokerWriteWhenAllGatesPass, true);
  assert.equal(report.liveExecutorArmProfile.allowExecutorWrite, true);
  assert.equal(report.safety.localBrokerExecutorWriteAllowedAfterGates, true);
  assert.equal(report.blockerPlan.status, "clear");
  assert.equal(report.blockerPlan.orderedActionCount, 0);
  assert.equal(report.blockerPlan.nextAction, "none_required");
  assert.equal(
    report.executionPayload.dispatchPolicy,
    "operator_adapter_may_execute_after_own_final_confirmation",
  );
} else {
  assert.equal(report.operatorCanExecute, false);
  assert.ok(report.blockers.length > 0);
  assert.equal(report.blockerPlan.status, "blocked");
  assert.ok(report.blockerPlan.orderedActionCount > 0);
  assert.notEqual(report.blockerPlan.nextAction, "none_required");
  if (report.liveExecutorArmProfile.allowFieldContract.explicitFailure === true) {
    assert.ok(
      report.blockers.some((item) =>
        String(item).startsWith("liveExecutor:arm-profile-field-contract-"),
      ),
    );
  }
  const armAction = report.blockerPlan.orderedActions.find(
    (action) => action.id === "live_executor_arm_profile",
  );
  if (armAction) {
    assert.equal(typeof armAction.stagedRearmProfilePath, "string");
    assert.equal(typeof armAction.activeProfileWriteSuppressed, "boolean");
    assert.equal(typeof armAction.allowedWriter, "string");
  }
  assert.equal(report.executionPayload.dispatchPolicy, "blocked_do_not_send");
  assert.equal(report.safety.localBrokerExecutorWriteAllowedAfterGates, false);
}

await fs.access(report.paths.reportPath);
await fs.access(report.paths.markdownPath);
await fs.access(report.paths.packetPath);

process.stdout.write(
  [
    "CAPITAL_LIVE_OPERATOR_EXECUTION_PACKET_CHECK=OK",
    `status=${report.status}`,
    `sha256=${report.sealedIntentSha256}`,
    `operatorCanExecute=${report.operatorCanExecute}`,
    `executorArm=${report.liveExecutorArmProfile.status}`,
    `readiness=${report.readiness.status}`,
    `adapterAck=${report.adapterAck.status}`,
    `adapterApplyReceipt=${report.adapterAck.applyReceipt.status}`,
    "no_live_order_sent=true",
    `blockers=${report.blockers.length}`,
  ].join("\n") + "\n",
);
