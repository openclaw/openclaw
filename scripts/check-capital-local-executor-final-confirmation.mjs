#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildCapitalLocalExecutorFinalConfirmation } from "./openclaw-capital-local-executor-final-confirmation.mjs";

const report = await buildCapitalLocalExecutorFinalConfirmation({
  repoRoot: process.cwd(),
  execute: false,
  confirmSha256: "",
});

assert.equal(report.schema, "openclaw.capital.local-executor-final-confirmation.v1");
assert.equal(typeof report.status, "string");
assert.ok(["blocked", "ready_for_local_executor_final_confirmation"].includes(report.status));
assert.equal(report.mode, "local_executor_final_confirmation");
assert.equal(report.execute, false);
assert.equal(typeof report.sealedOrderIntentSha256, "string");
assert.equal(typeof report.autoRearm, "boolean");
assert.equal(typeof report.autoConfirmSha256, "boolean");
assert.equal(typeof report.confirmSha256Provided, "string");
assert.equal(typeof report.confirmSha256Effective, "string");
assert.ok(report.rearm === null || typeof report.rearm === "object");
assert.equal(typeof report.runtimeAutoLive, "object");
assert.equal(typeof report.runtimeAutoLive.eligible, "boolean");
assert.equal(typeof report.runtimeAutoLive.bypassDispatchPolicyForRuntimeAutoLive, "boolean");
assert.equal(typeof report.runtimeAutoLive.riskControlsPath, "string");
assert.equal(typeof report.dispatch.status, "string");
assert.equal(typeof report.dispatch.dispatchPolicy, "string");
assert.equal(typeof report.dispatch.operatorCanExecute, "boolean");
assert.equal(typeof report.dispatch.executorArmed, "boolean");
assert.equal(typeof report.service.commandFilePath, "string");
assert.equal(report.safety.brokerApiCalled, false);
assert.equal(report.safety.conversationAgentDirectBrokerWrite, false);
assert.equal(report.safety.sentOrder, false);
assert.equal(report.safety.noLiveOrderSent, true);
assert.equal(Array.isArray(report.blockers), true);
assert.equal(typeof report.nextSafeTask, "string");
assert.equal(typeof report.machineLine, "string");
assert.equal(typeof report.paths.reportPath, "string");
assert.equal(typeof report.paths.panelPath, "string");
assert.equal(typeof report.paths.auditLogPath, "string");

process.stdout.write(
  [
    "CAPITAL_LOCAL_EXECUTOR_FINAL_CONFIRMATION_CHECK=OK",
    `status=${report.status}`,
    `dispatch=${report.dispatch.dispatchPolicy}`,
    `operatorCanExecute=${report.dispatch.operatorCanExecute}`,
    `executorArmed=${report.dispatch.executorArmed}`,
    `sentOrder=${report.safety.sentOrder}`,
  ].join("\n") + "\n",
);
