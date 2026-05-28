import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { runCapitalThousandRunSimulation } from "./openclaw-capital-thousand-run-simulation.mjs";

const repoRoot = process.cwd();
const report = await runCapitalThousandRunSimulation({
  repoRoot,
  runs: 1000,
  seed: 20260521,
  writeState: true,
  check: true,
});

assert.equal(report.schema, "openclaw.capital.thousand-run-simulation.v1");
assert.equal(report.inputs.runs, 1000);
assert.equal(report.summary.runs, 1000);
assert.ok(report.inputs.intentCount > 0, "simulation needs paper intents");
assert.equal(report.safety.liveTradingEnabled, false);
assert.equal(report.safety.writeBrokerOrders, false);
assert.equal(report.safety.liveTradingExecution, false);
assert.equal(report.safety.brokerWriteExecution, false);
assert.equal(report.safety.orderModeDryrunPass, true);
assert.equal(report.safety.noLiveOrderSent, true);
assert.equal(report.riskGates.simulationSweepRequired, true);
assert.equal(report.riskGates.minSimulationRuns, 1000);
assert.equal(report.riskGates.blockLiveOnNegativeSimulationP05Pnl, true);
assert.equal(report.riskGates.blockLiveOnSimulationP95DrawdownExceed, true);
assert.ok(report.riskGates.maxAllowedSimulationP95DrawdownPts <= 500);
assert.equal(report.riskGates.requireWalkForwardBeforeLivePromotion, true);
assert.ok(["pass_with_findings", "review_required"].includes(report.status));
assert.ok(Array.isArray(report.findings.fixNow));
assert.ok(Array.isArray(report.findings.addFeatures));
assert.ok(Array.isArray(report.findings.verification));

const jsonPath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-thousand-run-simulation-latest.json",
);
const persisted = JSON.parse(await fs.readFile(jsonPath, "utf8"));
assert.equal(persisted.schema, report.schema);
assert.equal(persisted.summary.runs, 1000);
assert.equal(persisted.safety.writeBrokerOrders, false);
assert.equal(persisted.riskGates.stressRiskEnforced, report.riskGates.stressRiskEnforced);

process.stdout.write(
  `CAPITAL_THOUSAND_RUN_SIMULATION_CHECK=OK runs=${report.summary.runs} recommendation=${report.recommendation} fixes=${report.findings.fixNow.length} features=${report.findings.addFeatures.length}\n`,
);
