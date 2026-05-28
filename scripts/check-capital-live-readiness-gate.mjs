#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-readiness-gate-latest.json",
);
const ALLOWED_STATUSES = new Set(["blocked", "ready_for_operator_adapter_review"]);
const REQUIRED_CHECKS = new Set([
  "source:platform",
  "source:direct-pretrade",
  "source:adapter-ack",
  "source:promotion",
  "source:operator-status",
  "source:arm-profile",
  "quote:strategy-fresh",
  "strategy:paper-promoted",
  "direct:pretrade-allowed",
  "position:verified-snapshot",
  "adapter:ack-usable",
  "promotion:manual-review-ready",
  "operator:live-enabled",
  "executor:arm-profile-armed",
  "safety:no-live-order-sent",
  "safety:readiness-gate-no-broker-write",
]);

const report = JSON.parse(await fs.readFile(REPORT_PATH, "utf8"));
const checks = Array.isArray(report.checks) ? report.checks : [];
const checkById = new Map(checks.map((item) => [item.id, item]));
const failedRequiredChecks = [...REQUIRED_CHECKS].filter(
  (id) => checkById.get(id)?.status !== "pass",
);

assert.equal(report.schema, "openclaw.capital.live-readiness-gate.v1");
assert.ok(ALLOWED_STATUSES.has(report.status), `status=${report.status}`);
assert.equal(typeof report.sealedOrderIntentSha256, "string");
assert.notEqual(report.sealedOrderIntentSha256.length, 0);
assert.equal(report.safety?.liveTradingEnabled, false);
assert.equal(report.safety?.writeBrokerOrders, false);
assert.equal(report.safety?.externalWriteEnabled, false);
assert.equal(report.safety?.brokerOrderPathEnabled, false);
assert.equal(report.safety?.sendLiveOrderCapability, false);
assert.equal(report.safety?.readOnlyPreflightOnly, true);
assert.equal(report.safety?.mustBeExecutedByExternalOperatorOwnedBrokerAdapter, true);
assert.equal(report.safety?.codexBrokerWriteAllowed, false);
assert.equal(report.safety?.claudeBrokerWriteAllowed, false);
assert.equal(report.safety?.openclawBrokerWriteAllowed, false);
assert.equal(report.safety?.telegramBrokerWriteAllowed, false);
assert.equal(report.safety?.sentOrder, false);
assert.equal(report.safety?.noLiveOrderSent, true);
assert.equal(report.safety?.no_live_order_sent, true);
assert.equal(typeof report.safety?.localBrokerExecutorArmed, "boolean");
assert.equal(report.safety?.localBrokerExecutorMayWriteAfterAllGates, false);
assert.equal(report.readiness?.direct?.sentOrder, false);
assert.equal(typeof report.readiness?.externalBrokerAdapter?.ackGateStatus, "string");
assert.equal(typeof report.readiness?.externalBrokerAdapter?.hashOk, "boolean");
assert.equal(typeof report.readiness?.externalBrokerAdapter?.canaryPass, "boolean");
assert.equal(typeof report.readiness?.externalBrokerAdapter?.rollbackPass, "boolean");
assert.equal(typeof report.readiness?.externalBrokerAdapter?.requiredTemplatePath, "string");
assert.equal(typeof report.readiness?.externalBrokerAdapter?.refreshPlan?.status, "string");
assert.equal(typeof report.readiness?.externalBrokerAdapter?.refreshPlan?.reason, "string");
assert.equal(typeof report.readiness?.externalBrokerAdapter?.refreshPlan?.sourcePath, "string");
assert.equal(
  typeof report.readiness?.externalBrokerAdapter?.refreshPlan?.destinationPath,
  "string",
);
assert.equal(
  typeof report.readiness?.externalBrokerAdapter?.refreshPlan?.safeToPromoteCandidate,
  "boolean",
);
assert.equal(
  typeof report.readiness?.externalBrokerAdapter?.refreshPlan?.candidateRollbackVerifiedAt,
  "string",
);
assert.equal(
  typeof report.readiness?.externalBrokerAdapter?.refreshPlan?.activeAckWriteSuppressed,
  "boolean",
);
assert.equal(
  typeof report.readiness?.externalBrokerAdapter?.refreshPlan?.conversationAgentsMayWriteActiveAck,
  "boolean",
);
assert.equal(typeof report.readiness?.externalBrokerAdapter?.refreshPlan?.allowedWriter, "string");
assert.equal(
  typeof report.readiness?.externalBrokerAdapter?.refreshPlan?.validationCommand,
  "string",
);
assert.equal(
  typeof report.readiness?.externalBrokerAdapter?.refreshPlan?.postRefreshValidationCommand,
  "string",
);
assert.equal(typeof report.readiness?.liveExecutorArmProfile?.status, "string");
assert.equal(typeof report.readiness?.liveExecutorArmProfile?.armed, "boolean");
assert.equal(typeof report.readiness?.liveExecutorArmProfile?.allowExecutorWrite, "boolean");
assert.equal(report.readiness?.liveExecutorArmProfile?.allowConversationAgentDirectWrite, false);
assert.equal(checkById.get("safety:no-live-order-sent")?.status, "pass");
assert.equal(checkById.get("safety:readiness-gate-no-broker-write")?.status, "pass");

for (const id of REQUIRED_CHECKS) {
  assert.ok(checkById.has(id), `missing check ${id}`);
}

if (checkById.get("adapter:ack-usable")?.status !== "pass") {
  assert.ok(report.blockers.includes("adapter:ack-usable"));
}
if (checkById.get("strategy:paper-promoted")?.status !== "pass") {
  assert.ok(report.blockers.includes("strategy:paper-promoted"));
}
if (checkById.get("executor:arm-profile-armed")?.status !== "pass") {
  assert.ok(report.blockers.includes("executor:arm-profile-armed"));
}
if (report.status === "ready_for_operator_adapter_review") {
  assert.equal(report.blockers.length, 0);
  assert.equal(failedRequiredChecks.length, 0);
  assert.equal(checkById.get("direct:pretrade-allowed")?.status, "pass");
  assert.equal(report.readiness?.externalBrokerAdapter?.ackUsable, true);
  assert.equal(report.readiness?.promotion?.readyForManualReview, true);
  assert.equal(report.readiness?.operator?.enabledAfter, true);
  assert.equal(report.readiness?.liveExecutorArmProfile?.allowExecutorWrite, true);
} else {
  assert.ok(report.blockers.length > 0);
  if (report.readiness?.externalBrokerAdapter?.hashOk === false) {
    assert.equal(
      report.readiness.externalBrokerAdapter.refreshPlan.status,
      "operator_refresh_required",
    );
    assert.equal(
      report.readiness.externalBrokerAdapter.refreshPlan.reason,
      "active_ack_hash_mismatch",
    );
    assert.equal(
      report.readiness.externalBrokerAdapter.refreshPlan.safeToPromoteCandidate,
      report.readiness.externalBrokerAdapter.rollbackPass === true &&
        report.readiness.externalBrokerAdapter.rollbackFresh === true,
    );
    assert.notEqual(
      report.readiness.externalBrokerAdapter.refreshPlan.candidateRollbackVerifiedAt,
      "ISO-8601",
    );
    assert.match(
      report.readiness.externalBrokerAdapter.refreshPlan.candidateRollbackVerifiedAt,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  }
}

assert.equal(typeof report.machineLine, "string");
assert.match(report.machineLine, /capitalLiveReadiness=/);
assert.match(report.machineLine, /sha256=/);
assert.match(report.machineLine, /ackGate=/);
assert.match(report.machineLine, /hashOk=/);
assert.match(report.machineLine, /executorArm=/);
assert.match(report.machineLine, /executorArmed=/);
assert.match(report.machineLine, /noOrderWrite=true/);
assert.match(report.machineLine, /sentOrder=false/);
assert.equal(typeof report.nextSafeTask, "string");
assert.notEqual(report.nextSafeTask.length, 0);
await fs.access(report.paths.reportPath);
await fs.access(report.paths.panelPath);
await fs.access(report.paths.markdownPath);

process.stdout.write(
  [
    "CAPITAL_LIVE_READINESS_GATE_CHECK=OK",
    `status=${report.status}`,
    `sha256=${report.sealedOrderIntentSha256}`,
    `position=${report.readiness.positionDecision.status}`,
    `ack=${report.readiness.externalBrokerAdapter.ackStatus}`,
    `executorArm=${report.readiness.liveExecutorArmProfile.status}`,
    `quote=${report.readiness.quote.overallFreshness}`,
    "no_live_order_sent=true",
    `blockers=${report.blockers.length}`,
  ].join("\n") + "\n",
);
