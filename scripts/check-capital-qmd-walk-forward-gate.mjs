import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runCapitalQmdWalkForwardGate } from "./openclaw-capital-qmd-walk-forward-gate.mjs";

const repoRoot = process.cwd();
const report = await runCapitalQmdWalkForwardGate({
  repoRoot,
  writeState: true,
  check: true,
});

assert.equal(report.schema, "openclaw.capital.qmd-walk-forward-gate.v1");
assert.equal(report.safety.liveTradingEnabled, false);
assert.equal(report.safety.writeBrokerOrders, false);
assert.equal(report.safety.brokerOrderPathEnabled, false);
assert.equal(report.safety.sentOrder, false);
assert.equal(report.safety.loginAttempted, false);
assert.equal(report.safety.readOnlyHistoricalReplayOnly, true);
assert.ok(
  [
    "passed",
    "blocked_walk_forward_failed",
    "blocked_insufficient_test_trades",
    "blocked_insufficient_history_days",
    "blocked_no_qmd_bars",
  ].includes(report.status),
);
assert.ok(Array.isArray(report.folds));
assert.ok(report.inputs.rowsScanned >= 0);

const jsonPath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-qmd-walk-forward-gate-latest.json",
);
const persisted = JSON.parse(await fs.readFile(jsonPath, "utf8"));
assert.equal(persisted.schema, report.schema);
assert.equal(persisted.status, report.status);
assert.equal(persisted.safety.writeBrokerOrders, false);

process.stdout.write(
  [
    "CAPITAL_QMD_WALK_FORWARD_GATE_CHECK=OK",
    `status=${report.status}`,
    `usedDays=${report.inputs.usedDays}`,
    `testTrades=${report.summary.totalTestTrades}`,
    `positiveFoldRate=${report.summary.positiveFoldRate}`,
    `testPnlPts=${report.summary.totalTestPnlPts}`,
    `maxDrawdownPts=${report.summary.maxTestDrawdownPts}`,
  ].join("\n") + "\n",
);
