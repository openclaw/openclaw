import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCapitalLiveTradingOperatorGate } from "./openclaw-capital-live-trading-operator-gate.mjs";

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function buildExpectedApprovalToken(approval, approvalPath) {
  const accounts = (Array.isArray(approval.accountAllowlist) ? approval.accountAllowlist : [])
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  const seed = JSON.stringify({
    schema: approval.schema || "",
    approvalPath: path.resolve(approvalPath),
    accounts,
    accountAllowlistSource: approval.accountAllowlistSource || "",
  });
  return `approve-capital-live-${sha256Text(seed).slice(0, 20).toLowerCase()}`;
}

const repoRoot = process.cwd();
const sourceApprovalPath = path.join(repoRoot, "config", "capital-live-trading-approval.json");
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capital-operator-gate-"));
const fixtureApprovalPath = path.join(tempDir, "capital-live-trading-approval.fixture.json");
const fixtureRiskControlsPath = path.join(tempDir, "risk-controls.fixture.json");
const fixtureReportPath = path.join(tempDir, "operator-gate-report.fixture.json");

await fs.copyFile(sourceApprovalPath, fixtureApprovalPath);
await fs.writeFile(
  fixtureRiskControlsPath,
  `${JSON.stringify(
    {
      allowLiveTrading: false,
      writeBrokerOrders: false,
      liveActivation: { enabled: false },
      liveDeactivation: { enabled: true },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const approvalFixture = JSON.parse(await fs.readFile(fixtureApprovalPath, "utf8"));
const expectedToken = buildExpectedApprovalToken(approvalFixture, fixtureApprovalPath);
const now = new Date("2026-05-23T02:00:00.000Z");

const status = await runCapitalLiveTradingOperatorGate({
  action: "status",
  now,
  approvalPath: fixtureApprovalPath,
  riskControlsPath: fixtureRiskControlsPath,
  reportPath: fixtureReportPath,
  writeState: true,
});
assert.equal(status.report.schema, "openclaw.capital.live-trading-operator-gate.v1");
assert.equal(status.report.status, "live_disabled");
assert.equal(status.report.applied, false);
assert.equal(status.report.riskControls.enabledAfter, false);
assert.equal(status.report.safety.sentOrder, false);
await fs.access(fixtureReportPath);
await fs.access(`${fixtureReportPath}.sha256`);

const blockedActivate = await runCapitalLiveTradingOperatorGate({
  action: "activate",
  now,
  approvalPath: fixtureApprovalPath,
  riskControlsPath: fixtureRiskControlsPath,
  operator: "",
  token: "",
  execute: false,
  writeState: false,
});
assert.equal(blockedActivate.report.status, "blocked");
assert.equal(blockedActivate.report.applied, false);
assert.equal(blockedActivate.report.blockerCode, "LIVE_OPERATOR_PRECONDITIONS_FAILED");
assert.ok(blockedActivate.report.blockers.includes("approval:token-match"));
assert.ok(blockedActivate.report.blockers.includes("approval:operator-present"));
assert.equal(blockedActivate.report.riskControls.enabledAfter, false);

const readyActivate = await runCapitalLiveTradingOperatorGate({
  action: "activate",
  now,
  approvalPath: fixtureApprovalPath,
  riskControlsPath: fixtureRiskControlsPath,
  operator: "fixture-operator",
  token: expectedToken,
  ttlMinutes: 1,
  execute: false,
  writeState: false,
});
assert.equal(readyActivate.report.status, "ready_to_activate");
assert.equal(readyActivate.report.applied, false);
assert.equal(readyActivate.report.riskControls.enabledAfter, false);

const activated = await runCapitalLiveTradingOperatorGate({
  action: "activate",
  now,
  approvalPath: fixtureApprovalPath,
  riskControlsPath: fixtureRiskControlsPath,
  operator: "fixture-operator",
  token: expectedToken,
  ttlMinutes: 1,
  execute: true,
  writeState: false,
});
assert.equal(activated.report.status, "activated");
assert.equal(activated.report.applied, true);
assert.equal(activated.report.riskControls.enabledAfter, true);

const activatedRisk = JSON.parse(await fs.readFile(fixtureRiskControlsPath, "utf8"));
assert.equal(activatedRisk.allowLiveTrading, true);
assert.equal(activatedRisk.writeBrokerOrders, true);
assert.equal(activatedRisk.liveActivation.enabled, true);
assert.equal(activatedRisk.liveActivation.operator, "fixture-operator");
assert.equal(activatedRisk.liveDeactivation.enabled, false);

const reconcileDryRun = await runCapitalLiveTradingOperatorGate({
  action: "reconcile",
  now: new Date("2026-05-23T02:02:01.000Z"),
  approvalPath: fixtureApprovalPath,
  riskControlsPath: fixtureRiskControlsPath,
  execute: false,
  writeState: false,
});
assert.equal(reconcileDryRun.report.status, "expired_pending_auto_deactivate");
assert.equal(reconcileDryRun.report.applied, false);
assert.equal(reconcileDryRun.report.riskControls.enabledAfter, true);

const reconcileExecute = await runCapitalLiveTradingOperatorGate({
  action: "reconcile",
  now: new Date("2026-05-23T02:02:01.000Z"),
  approvalPath: fixtureApprovalPath,
  riskControlsPath: fixtureRiskControlsPath,
  execute: true,
  writeState: false,
});
assert.equal(reconcileExecute.report.status, "expired_auto_deactivated");
assert.equal(reconcileExecute.report.applied, true);
assert.equal(reconcileExecute.report.riskControls.enabledAfter, false);

const deactivated = await runCapitalLiveTradingOperatorGate({
  action: "deactivate",
  now: new Date("2026-05-23T02:03:00.000Z"),
  approvalPath: fixtureApprovalPath,
  riskControlsPath: fixtureRiskControlsPath,
  operator: "fixture-operator",
  reason: "fixture-final-deactivate",
  execute: true,
  writeState: false,
});
assert.equal(deactivated.report.status, "deactivated");
assert.equal(deactivated.report.applied, true);
assert.equal(deactivated.report.riskControls.enabledAfter, false);

const finalRisk = JSON.parse(await fs.readFile(fixtureRiskControlsPath, "utf8"));
assert.equal(finalRisk.allowLiveTrading, false);
assert.equal(finalRisk.writeBrokerOrders, false);
assert.equal(finalRisk.liveDeactivation.enabled, true);
assert.equal(finalRisk.liveDeactivation.reason, "fixture-final-deactivate");

process.stdout.write(
  [
    "CAPITAL_LIVE_TRADING_OPERATOR_GATE_CHECK=OK",
    `status=${status.report.status}`,
    `activate=${activated.report.status}`,
    `reconcile=${reconcileExecute.report.status}`,
    `deactivate=${deactivated.report.status}`,
    `enabledAfter=${deactivated.report.riskControls.enabledAfter}`,
    `sentOrder=${deactivated.report.safety.sentOrder}`,
  ].join("\n") + "\n",
);
