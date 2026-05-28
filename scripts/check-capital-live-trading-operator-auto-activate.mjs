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
  "openclaw-capital-live-trading-operator-auto-activate.mjs",
);

const tempDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "openclaw-capital-operator-auto-activate-"),
);
const fixtureApprovalPath = path.join(tempDir, "capital-live-trading-approval.fixture.json");
const fixtureRiskControlsPath = path.join(tempDir, "risk-controls.fixture.json");
const fixtureReportPath = path.join(tempDir, "operator-auto-activate-report.fixture.json");

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
  "--operator",
  "fixture-operator",
  "--write-state",
  "--json",
]);

assert.equal(dryRun.schema, "openclaw.capital.live-trading-operator-auto-activate.v1");
assert.equal(dryRun.status, "ready_to_activate");
assert.equal(dryRun.applied, false);
assert.equal(dryRun.enabledAfter, false);
assert.equal(dryRun.sentOrder, false);
assert.equal(path.resolve(dryRun.riskControlsPath), path.resolve(fixtureRiskControlsPath));
await fs.access(fixtureReportPath);
await fs.access(`${fixtureReportPath}.sha256`);

const executeRun = runJson([
  "--approval",
  fixtureApprovalPath,
  "--risk-controls",
  fixtureRiskControlsPath,
  "--report",
  fixtureReportPath,
  "--operator",
  "fixture-operator",
  "--ttl-min",
  "1",
  "--execute",
  "--write-state",
  "--json",
]);

assert.equal(executeRun.schema, "openclaw.capital.live-trading-operator-auto-activate.v1");
assert.equal(executeRun.status, "activated");
assert.equal(executeRun.applied, true);
assert.equal(executeRun.enabledAfter, true);
assert.equal(executeRun.sentOrder, false);
assert.equal(path.resolve(executeRun.riskControlsPath), path.resolve(fixtureRiskControlsPath));

const riskAfter = JSON.parse(await fs.readFile(fixtureRiskControlsPath, "utf8"));
assert.equal(riskAfter.allowLiveTrading, true);
assert.equal(riskAfter.writeBrokerOrders, true);
assert.equal(riskAfter.liveActivation.enabled, true);
assert.equal(riskAfter.liveActivation.operator, "fixture-operator");

process.stdout.write(
  [
    "CAPITAL_LIVE_TRADING_OPERATOR_AUTO_ACTIVATE_CHECK=OK",
    `dryRun=${dryRun.status}`,
    `execute=${executeRun.status}`,
    `enabledAfter=${executeRun.enabledAfter}`,
    `sentOrder=${executeRun.sentOrder}`,
  ].join("\n") + "\n",
);
