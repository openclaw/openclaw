import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const sourceApprovalPath = path.join(repoRoot, "config", "capital-live-trading-approval.json");
const scriptPath = path.join(
  repoRoot,
  "scripts",
  "openclaw-capital-live-trading-operator-auto-guard.mjs",
);

function runJson(args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `command failed: node ${path.basename(scriptPath)} ${args.join(" ")}`,
        `status=${result.status}`,
        `stdout=${result.stdout || ""}`,
        `stderr=${result.stderr || ""}`,
      ].join("\n"),
    );
  }
  return JSON.parse(result.stdout);
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capital-operator-auto-guard-"));
const fixtureApprovalPath = path.join(tempDir, "capital-live-trading-approval.fixture.json");
const fixtureRiskDisabledPath = path.join(tempDir, "risk-controls.disabled.fixture.json");
const fixtureRiskExpiredPath = path.join(tempDir, "risk-controls.expired.fixture.json");
const fixtureReportPath = path.join(tempDir, "operator-auto-guard-report.fixture.json");

await fs.copyFile(sourceApprovalPath, fixtureApprovalPath);

await fs.writeFile(
  fixtureRiskDisabledPath,
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

await fs.writeFile(
  fixtureRiskExpiredPath,
  `${JSON.stringify(
    {
      allowLiveTrading: true,
      writeBrokerOrders: true,
      liveActivation: {
        enabled: true,
        activatedAt: "2026-05-24T00:00:00.000Z",
        expiresAt: "2026-05-24T00:01:00.000Z",
        ttlMinutes: 1,
        operator: "fixture-operator",
        reason: "fixture-activation",
        source: "fixture",
      },
      liveDeactivation: { enabled: false },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const disabledRun = runJson([
  "--approval",
  fixtureApprovalPath,
  "--risk-controls",
  fixtureRiskDisabledPath,
  "--report",
  fixtureReportPath,
  "--write-state",
  "--json",
]);

assert.equal(disabledRun.schema, "openclaw.capital.live-trading-operator-auto-guard.v1");
assert.equal(disabledRun.status, "guard_live_disabled_idle");
assert.equal(disabledRun.guardAction, "status_only");
assert.equal(disabledRun.applied, false);
assert.equal(disabledRun.enabledBefore, false);
assert.equal(disabledRun.enabledAfter, false);
assert.equal(disabledRun.sentOrder, false);

const expiredDryRun = runJson([
  "--approval",
  fixtureApprovalPath,
  "--risk-controls",
  fixtureRiskExpiredPath,
  "--report",
  fixtureReportPath,
  "--write-state",
  "--json",
]);

assert.equal(expiredDryRun.status, "guard_expired_pending_reconcile");
assert.equal(expiredDryRun.guardAction, "reconcile_expired_activation");
assert.equal(expiredDryRun.applied, false);
assert.equal(expiredDryRun.enabledBefore, true);
assert.equal(expiredDryRun.enabledAfter, true);
assert.equal(expiredDryRun.activationExpired, true);
assert.equal(expiredDryRun.sentOrder, false);
await fs.access(fixtureReportPath);
await fs.access(`${fixtureReportPath}.sha256`);

const expiredExecute = runJson([
  "--approval",
  fixtureApprovalPath,
  "--risk-controls",
  fixtureRiskExpiredPath,
  "--report",
  fixtureReportPath,
  "--execute",
  "--write-state",
  "--json",
]);

assert.equal(expiredExecute.status, "guard_expired_reconciled");
assert.equal(expiredExecute.guardAction, "reconcile_expired_activation");
assert.equal(expiredExecute.applied, true);
assert.equal(expiredExecute.enabledBefore, true);
assert.equal(expiredExecute.enabledAfter, false);
assert.equal(expiredExecute.sentOrder, false);

const riskAfter = JSON.parse(await fs.readFile(fixtureRiskExpiredPath, "utf8"));
assert.equal(riskAfter.allowLiveTrading, false);
assert.equal(riskAfter.writeBrokerOrders, false);
assert.equal(riskAfter.liveDeactivation.enabled, true);
assert.equal(riskAfter.liveDeactivation.reason, "activation_ttl_expired");

process.stdout.write(
  [
    "CAPITAL_LIVE_TRADING_OPERATOR_AUTO_GUARD_CHECK=OK",
    `disabled=${disabledRun.status}`,
    `expiredDryRun=${expiredDryRun.status}`,
    `expiredExecute=${expiredExecute.status}`,
    `enabledAfter=${expiredExecute.enabledAfter}`,
    `sentOrder=${expiredExecute.sentOrder}`,
  ].join("\n") + "\n",
);
