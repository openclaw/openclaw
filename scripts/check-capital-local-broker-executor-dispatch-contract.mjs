#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-local-broker-executor-dispatch-contract-latest.json",
);
const ALLOWED_STATUSES = new Set(["blocked", "ready_for_local_executor_final_confirmation"]);
const ALLOWED_POLICIES = new Set([
  "blocked_do_not_send",
  "local_executor_may_dispatch_after_executor_owned_final_confirmation",
]);

const report = JSON.parse(await fs.readFile(REPORT_PATH, "utf8"));

assert.equal(report.schema, "openclaw.capital.local-broker-executor-dispatch-contract.v1");
assert.ok(ALLOWED_STATUSES.has(report.status), `status=${report.status}`);
assert.ok(ALLOWED_POLICIES.has(report.dispatchPolicy), `dispatchPolicy=${report.dispatchPolicy}`);
assert.equal(typeof report.sealedIntentSha256, "string");
assert.notEqual(report.sealedIntentSha256.length, 0);
assert.equal(typeof report.operatorPacket?.operatorCanExecute, "boolean");
assert.equal(typeof report.operatorPacket?.adapterAckHashOk, "boolean");
assert.equal(typeof report.operatorPacket?.adapterAckRefreshPlan?.status, "string");
assert.equal(
  typeof report.operatorPacket?.adapterAckRefreshPlan?.candidateRollbackVerifiedAt,
  "string",
);
assert.equal(typeof report.adapterAck?.status, "string");
assert.equal(typeof report.adapterAck?.hashOk, "boolean");
assert.equal(typeof report.adapterAck?.refreshPlan?.candidateRollbackVerifiedAt, "string");
assert.equal(report.executor?.id, "openclaw-managed-capital-live-executor");
assert.equal(report.executor?.target, "openclaw_managed_local_broker_executor");
assert.equal(report.executor?.credentialOwner, "local_broker_executor");
assert.equal(report.executor?.finalConfirmationRequired, true);
assert.equal(typeof report.executor?.armed, "boolean");
assert.equal(report.dispatchContract?.destination, "openclaw_managed_local_broker_executor");
assert.equal(typeof report.dispatchContract?.payloadHash, "string");
assert.notEqual(report.dispatchContract.payloadHash.length, 0);
assert.equal(report.dispatchContract?.writesBrokerCommandFile, false);
assert.equal(report.dispatchContract?.brokerApiCalled, false);
assert.equal(report.safety?.generatedContractOnly, true);
assert.equal(report.safety?.reportOnly, true);
assert.equal(report.safety?.wroteBrokerCommand, false);
assert.equal(report.safety?.brokerApiCalled, false);
assert.equal(report.safety?.brokerWriteAttempted, false);
assert.equal(report.safety?.liveTradingEnabled, false);
assert.equal(report.safety?.writeBrokerOrders, false);
assert.equal(report.safety?.conversationAgentDirectBrokerWrite, false);
assert.equal(report.safety?.containsCredentials, false);
assert.equal(report.safety?.sentOrder, false);
assert.equal(report.safety?.noLiveOrderSent, true);
assert.equal(report.safety?.no_live_order_sent, true);
assert.match(report.machineLine, /capitalLocalExecutorDispatch=/);
assert.match(report.machineLine, /operatorCanExecute=/);
assert.match(report.machineLine, /executorArmed=/);
assert.match(report.machineLine, /dispatchPolicy=/);
assert.match(report.machineLine, /noOrderWrite=true/);
assert.match(report.machineLine, /sentOrder=false/);

if (report.status === "ready_for_local_executor_final_confirmation") {
  assert.equal(report.operatorPacket.operatorCanExecute, true);
  assert.equal(report.executor.armed, true);
  assert.equal(
    report.dispatchPolicy,
    "local_executor_may_dispatch_after_executor_owned_final_confirmation",
  );
  assert.equal(report.safety.localBrokerExecutorWriteAllowedAfterGates, true);
  assert.equal(report.blockers.length, 0);
} else {
  assert.equal(report.dispatchPolicy, "blocked_do_not_send");
  assert.equal(report.safety.localBrokerExecutorWriteAllowedAfterGates, false);
  assert.ok(report.blockers.length > 0);
  if (report.operatorPacket.operatorCanExecute === false) {
    assert.ok(report.blockers.includes("operatorPacket:not-executable"));
  }
  if (report.adapterAck.hashOk === false && report.adapterAck.refreshPlan.safeToPromoteCandidate) {
    assert.notEqual(report.adapterAck.refreshPlan.candidateRollbackVerifiedAt, "ISO-8601");
    assert.match(
      report.adapterAck.refreshPlan.candidateRollbackVerifiedAt,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
    assert.equal(
      report.operatorPacket.adapterAckRefreshPlan.candidateRollbackVerifiedAt,
      report.adapterAck.refreshPlan.candidateRollbackVerifiedAt,
    );
  }
}

await fs.access(report.paths.reportPath);
await fs.access(report.paths.markdownPath);
await fs.access(report.paths.panelPath);

process.stdout.write(
  [
    "CAPITAL_LOCAL_BROKER_EXECUTOR_DISPATCH_CONTRACT_CHECK=OK",
    `status=${report.status}`,
    `sha256=${report.sealedIntentSha256}`,
    `operatorCanExecute=${report.operatorPacket.operatorCanExecute}`,
    `executorArmed=${report.executor.armed}`,
    `dispatchPolicy=${report.dispatchPolicy}`,
    "no_live_order_sent=true",
    `blockers=${report.blockers.length}`,
  ].join("\n") + "\n",
);
