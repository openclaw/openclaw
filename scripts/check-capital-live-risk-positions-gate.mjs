import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCapitalLiveRiskPositionsGate } from "./openclaw-capital-live-risk-positions-gate.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};

assert.equal(
  scripts["capital:live-risk-positions:gate"],
  "node scripts/openclaw-capital-live-risk-positions-gate.mjs --write-state --json",
);
assert.equal(
  scripts["capital:live-risk-positions:gate:check"],
  "node scripts/check-capital-live-risk-positions-gate.mjs",
);
assert.equal(
  scripts["capital-hft:live-risk-positions:gate"],
  "node scripts/openclaw-capital-live-risk-positions-gate.mjs --write-state --json",
);
assert.equal(
  scripts["capital-hft:live-risk-positions:gate:check"],
  "node scripts/check-capital-live-risk-positions-gate.mjs",
);

const { report } = await runCapitalLiveRiskPositionsGate({
  writeState: true,
});

assert.equal(report.schema, "openclaw.capital.live-risk-positions-gate.v1");
assert.equal(report.mode, "read_only_gate");
assert.equal(report.status, "blocked");
assert.equal(report.blockerCode, "LIVE_RISK_POSITIONS_RUNTIME_BLOCKED");
assert.equal(report.safety.allowLiveTrading, false);
assert.equal(report.safety.writeBrokerOrders, false);
assert.equal(report.safety.externalWriteEnabled, false);
assert.equal(report.safety.sentOrder, false);
assert.equal(report.safety.loginAttempted, false);
assert.equal(report.safety.readOnlyReportOnly, true);
assert.ok(Array.isArray(report.checks));
assert.ok(report.checks.length >= 3);
assert.ok(report.checks.some((item) => item.id === "live-risk:runtime-write-forbidden"));
assert.ok(Array.isArray(report.blockers));
assert.ok(report.blockers.includes("live-risk:runtime-write-forbidden"));
assert.equal(typeof report.nextSafeTask, "string");
assert.notEqual(report.nextSafeTask.trim(), "");

process.stdout.write(
  [
    "CAPITAL_LIVE_RISK_POSITIONS_GATE_CHECK=OK",
    `status=${report.status}`,
    `blockerCode=${report.blockerCode}`,
    `sourceExists=${report.source.exists}`,
    `jsonValid=${report.source.jsonValid}`,
  ].join("\n") + "\n",
);
