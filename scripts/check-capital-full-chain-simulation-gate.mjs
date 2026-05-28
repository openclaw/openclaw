import assert from "node:assert/strict";
import { runCapitalFullChainSimulationGate } from "./openclaw-capital-full-chain-simulation-gate.mjs";

const { report } = await runCapitalFullChainSimulationGate({
  runs: 1000,
  writeState: true,
});

assert.equal(report.schema, "openclaw.capital.full-chain-simulation-gate.v1");
assert.ok(["passed", "blocked"].includes(report.status));
assert.equal(report.mode, "paper_full_chain_dryrun_fault_injection");
assert.equal(report.summary.runs, 1000);
assert.equal(Number.isInteger(report.summary.stageFailedCount), true);
assert.equal(Number.isInteger(report.summary.faultFailedCount), true);
if ("faultSkippedCount" in report.summary) {
  assert.equal(Number.isInteger(report.summary.faultSkippedCount), true);
  assert.equal(report.summary.faultSkippedCount >= 0, true);
}
assert.equal(report.summary.stageFailedCount >= 0, true);
assert.equal(report.summary.faultFailedCount >= 0, true);
assert.ok(report.summary.stageFailedCount <= report.summary.runs);
assert.ok(report.summary.faultFailedCount <= report.summary.runs);
assert.equal(typeof report.summary.normalPaperChainAllowed, "boolean");
assert.equal(typeof report.summary.normalPaperChainOk, "boolean");
assert.equal(report.safety.liveTradingEnabled, false);
assert.equal(report.safety.writeBrokerOrders, false);
assert.equal(report.safety.brokerOrderPathEnabled, false);
assert.equal(report.safety.noLiveOrderSent, true);
assert.equal(report.safety.sentOrder, false);
assert.equal(report.safety.readOnlyDryRunOnly, true);
assert.equal(report.liveRealismBoundary.liveOrderNotProven, true);
assert.ok(Array.isArray(report.stageChecks));
assert.equal(Number.isInteger(report.faultInjection.failedCaseCount), true);
assert.equal(report.faultInjection.failedCaseCount >= 0, true);
assert.equal(report.faultInjection.failedCaseCount, report.summary.faultFailedCount);
if ("skippedCaseCount" in report.faultInjection) {
  assert.equal(Number.isInteger(report.faultInjection.skippedCaseCount), true);
  assert.equal(report.faultInjection.skippedCaseCount >= 0, true);
  assert.equal(report.faultInjection.skippedCaseCount, report.summary.faultSkippedCount ?? 0);
}
assert.ok(Object.keys(report.faultInjection.byScenario).length >= 8);
assert.ok(Array.isArray(report.blockers));
if (report.status === "passed") {
  assert.ok(report.stageChecks.every((item) => item.status === "pass"));
  assert.equal(report.summary.stageFailedCount, 0);
  assert.equal(report.summary.faultFailedCount, 0);
  assert.equal(report.faultInjection.failedCaseCount, 0);
  assert.equal(report.summary.normalPaperChainAllowed, true);
  assert.equal(report.summary.normalPaperChainOk, true);
  assert.deepEqual(report.blockers, []);
} else {
  assert.ok(report.stageChecks.some((item) => item.status !== "pass"));
  assert.ok(
    report.summary.stageFailedCount > 0 ||
      report.summary.faultFailedCount > 0 ||
      !report.summary.normalPaperChainAllowed,
  );
  assert.ok(report.blockers.length >= 1);
}

process.stdout.write(
  [
    "CAPITAL_FULL_CHAIN_SIMULATION_GATE_CHECK=OK",
    `runs=${report.summary.runs}`,
    `stageFailed=${report.summary.stageFailedCount}`,
    `faultFailed=${report.summary.faultFailedCount}`,
    "live/write/order=OFF",
  ].join("\n") + "\n",
);
