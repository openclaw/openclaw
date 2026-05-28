import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCapitalStrategyRunnerGate } from "./openclaw-capital-strategy-runner-gate.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};

assert.equal(
  scripts["capital:strategy-runner:gate"],
  "node scripts/openclaw-capital-strategy-runner-gate.mjs --write-state --json",
);
assert.equal(
  scripts["capital:strategy-runner:gate:check"],
  "node scripts/check-capital-strategy-runner-gate.mjs",
);
assert.equal(
  scripts["capital-hft:strategy-runner:gate"],
  "node scripts/openclaw-capital-strategy-runner-gate.mjs --write-state --json",
);
assert.equal(
  scripts["capital-hft:strategy-runner:gate:check"],
  "node scripts/check-capital-strategy-runner-gate.mjs",
);

const { report } = await runCapitalStrategyRunnerGate({
  writeState: true,
});

assert.equal(report.schema, "openclaw.capital.strategy-runner-gate.v1");
assert.equal(report.mode, "read_only_gate");
assert.equal(report.status, "blocked");
assert.equal(report.blockerCode, "CAPITAL_STRATEGY_RUNNER_RUNTIME_BLOCKED");
assert.equal(report.safety.allowLiveTrading, false);
assert.equal(report.safety.writeBrokerOrders, false);
assert.equal(report.safety.externalWriteEnabled, false);
assert.equal(report.safety.sentOrder, false);
assert.equal(report.safety.loginAttempted, false);
assert.equal(report.safety.readOnlyReportOnly, true);
assert.ok(Array.isArray(report.checks));
assert.ok(report.checks.some((item) => item.id === "strategy-runner-gate:runtime-write-forbidden"));
assert.ok(Array.isArray(report.blockers));
assert.ok(report.blockers.includes("strategy-runner-gate:runtime-write-forbidden"));
assert.equal(typeof report.nextSafeTask, "string");
assert.notEqual(report.nextSafeTask.trim(), "");

process.stdout.write(
  [
    "CAPITAL_STRATEGY_RUNNER_GATE_CHECK=OK",
    `status=${report.status}`,
    `blockerCode=${report.blockerCode}`,
    `sourceExists=${report.source.exists}`,
    `engineImport=${report.detected.containsStrategyEngineImport}`,
  ].join("\n") + "\n",
);
