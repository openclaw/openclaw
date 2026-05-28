import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCapitalHftServiceRuntimeGate } from "./openclaw-capital-hft-service-runtime-gate.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
const scripts = packageJson.scripts ?? {};

assert.equal(
  scripts["capital:hft-service-runtime:gate"],
  "node scripts/openclaw-capital-hft-service-runtime-gate.mjs --write-state --json",
);
assert.equal(
  scripts["capital:hft-service-runtime:gate:check"],
  "node scripts/check-capital-hft-service-runtime-gate.mjs",
);
assert.equal(
  scripts["capital-hft:hft-service-runtime:gate"],
  "node scripts/openclaw-capital-hft-service-runtime-gate.mjs --write-state --json",
);
assert.equal(
  scripts["capital-hft:hft-service-runtime:gate:check"],
  "node scripts/check-capital-hft-service-runtime-gate.mjs",
);

const { report } = await runCapitalHftServiceRuntimeGate({
  writeState: true,
});

assert.equal(report.schema, "openclaw.capital.hft-service-runtime-gate.v1");
assert.equal(report.mode, "read_only_gate");
assert.equal(report.status, "blocked");
assert.equal(report.blockerCode, "CAPITAL_HFT_SERVICE_RUNTIME_BLOCKED");
assert.equal(report.safety.allowLiveTrading, false);
assert.equal(report.safety.writeBrokerOrders, false);
assert.equal(report.safety.externalWriteEnabled, false);
assert.equal(report.safety.sentOrder, false);
assert.equal(report.safety.loginAttempted, false);
assert.equal(report.safety.readOnlyReportOnly, true);
assert.ok(Array.isArray(report.checks));
assert.ok(report.checks.some((item) => item.id === "hft-service-gate:runtime-write-forbidden"));
assert.ok(Array.isArray(report.blockers));
assert.ok(report.blockers.includes("hft-service-gate:runtime-write-forbidden"));
assert.equal(typeof report.nextSafeTask, "string");
assert.notEqual(report.nextSafeTask.trim(), "");

process.stdout.write(
  [
    "CAPITAL_HFT_SERVICE_RUNTIME_GATE_CHECK=OK",
    `status=${report.status}`,
    `blockerCode=${report.blockerCode}`,
    `sourceExists=${report.source.exists}`,
    `containsSpawn=${report.detected.containsSpawn}`,
  ].join("\n") + "\n",
);
