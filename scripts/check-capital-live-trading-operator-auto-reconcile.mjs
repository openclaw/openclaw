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
  "openclaw-capital-live-trading-operator-auto-reconcile.mjs",
);

const tempDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "openclaw-capital-operator-auto-reconcile-"),
);
const fixtureApprovalPath = path.join(tempDir, "capital-live-trading-approval.fixture.json");
const fixtureRiskControlsPath = path.join(tempDir, "risk-controls.fixture.json");
const fixtureReportPath = path.join(tempDir, "operator-auto-reconcile-report.fixture.json");

await fs.copyFile(sourceApprovalPath, fixtureApprovalPath);
await fs.writeFile(
  fixtureRiskControlsPath,
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

const dryRun = runJson([
  "--approval",
  fixtureApprovalPath,
  "--risk-controls",
  fixtureRiskControlsPath,
  "--report",
  fixtureReportPath,
  "--write-state",
  "--json",
]);

assert.equal(dryRun.schema, "openclaw.capital.live-trading-operator-auto-reconcile.v1");
assert.equal(dryRun.status, "expired_pending_auto_deactivate");
assert.equal(dryRun.applied, false);
assert.equal(dryRun.enabledAfter, true);
assert.equal(dryRun.activationExpired, true);
assert.equal(dryRun.sentOrder, false);
await fs.access(fixtureReportPath);
await fs.access(`${fixtureReportPath}.sha256`);

const executeRun = runJson([
  "--approval",
  fixtureApprovalPath,
  "--risk-controls",
  fixtureRiskControlsPath,
  "--report",
  fixtureReportPath,
  "--execute",
  "--write-state",
  "--json",
]);

assert.equal(executeRun.schema, "openclaw.capital.live-trading-operator-auto-reconcile.v1");
assert.equal(executeRun.status, "expired_auto_deactivated");
assert.equal(executeRun.applied, true);
assert.equal(executeRun.enabledAfter, false);
assert.equal(executeRun.sentOrder, false);

const riskAfter = JSON.parse(await fs.readFile(fixtureRiskControlsPath, "utf8"));
assert.equal(riskAfter.allowLiveTrading, false);
assert.equal(riskAfter.writeBrokerOrders, false);
assert.equal(riskAfter.liveDeactivation.enabled, true);
assert.equal(riskAfter.liveDeactivation.reason, "activation_ttl_expired");

process.stdout.write(
  [
    "CAPITAL_LIVE_TRADING_OPERATOR_AUTO_RECONCILE_CHECK=OK",
    `dryRun=${dryRun.status}`,
    `execute=${executeRun.status}`,
    `enabledAfter=${executeRun.enabledAfter}`,
    `sentOrder=${executeRun.sentOrder}`,
  ].join("\n") + "\n",
);
