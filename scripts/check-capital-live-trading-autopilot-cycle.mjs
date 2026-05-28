#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const REPORT_PATH = path.join(
  process.cwd(),
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-trading-autopilot-cycle-latest.json",
);
const ALLOWED_STATUSES = new Set([
  "waiting_conditions",
  "ready_for_autopilot_execute",
  "major_event_guarded",
  "executed_dispatch_command_written",
]);

const report = JSON.parse(await fs.readFile(REPORT_PATH, "utf8"));

assert.equal(report.schema, "openclaw.capital.live-trading-autopilot-cycle.v1");
assert.ok(ALLOWED_STATUSES.has(report.status), `status=${report.status}`);
assert.equal(typeof report.execute, "boolean");
assert.equal(typeof report.action, "string");
assert.equal(typeof report.majorEvent, "boolean");
assert.equal(typeof report.majorEventLock, "boolean");
assert.equal(typeof report.activationExpired, "boolean");
assert.equal(typeof report.liveEnabled, "boolean");
assert.equal(typeof report.quoteFresh, "boolean");
assert.equal(typeof report.readinessStatus, "string");
assert.equal(typeof report.dispatchStatus, "string");
assert.equal(typeof report.operatorCanExecute, "boolean");
assert.equal(typeof report.executorArmed, "boolean");
assert.equal(typeof report.shouldAutoTrade, "boolean");
assert.ok(Array.isArray(report.blockers));
assert.equal(typeof report.safety, "object");
assert.equal(typeof report.safety.sentOrder, "boolean");
assert.equal(typeof report.safety.noLiveOrderSent, "boolean");
assert.equal(typeof report.safety.writeBrokerOrders, "boolean");
assert.equal(report.safety.conversationAgentDirectBrokerWrite, false);
assert.equal(typeof report.paths.reportPath, "string");
assert.equal(typeof report.paths.panelPath, "string");
assert.equal(typeof report.paths.riskControlsPath, "string");
assert.equal(typeof report.machineLine, "string");
assert.match(report.machineLine, /capitalLiveAutopilot=/);
assert.equal(typeof report.nextSafeTask, "string");

if (report.status === "executed_dispatch_command_written") {
  assert.equal(report.safety.sentOrder, true);
  assert.equal(report.safety.noLiveOrderSent, false);
  assert.equal(report.safety.writeBrokerOrders, true);
  assert.equal(typeof report.finalConfirmation?.status, "string");
  assert.equal(report.finalConfirmation?.sentOrder, true);
} else {
  assert.equal(report.safety.sentOrder, false);
  assert.equal(report.safety.noLiveOrderSent, true);
  assert.equal(report.safety.writeBrokerOrders, false);
}

if (report.status === "major_event_guarded") {
  assert.equal(report.majorEvent, true);
}

process.stdout.write(
  [
    "CAPITAL_LIVE_TRADING_AUTOPILOT_CYCLE_CHECK=OK",
    `status=${report.status}`,
    `action=${report.action}`,
    `majorEvent=${report.majorEvent}`,
    `liveEnabled=${report.liveEnabled}`,
    `sentOrder=${report.safety.sentOrder}`,
    `blockers=${report.blockers.length}`,
  ].join("\n") + "\n",
);
