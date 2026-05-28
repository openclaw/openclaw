import { buildCapitalSimulationDiagnostics } from "./openclaw-capital-simulation-diagnostics.mjs";

const report = await buildCapitalSimulationDiagnostics({
  repoRoot: process.cwd(),
  writeState: true,
  check: true,
});
const issues = [];

if (report.schema !== "openclaw.capital.simulation-diagnostics.v1") {
  issues.push("schema mismatch");
}
if (report.status !== "simulation_clean_live_blocked") {
  issues.push(`status=${report.status}`);
}
if (report.decision !== "paper_only_do_not_promote_live") {
  issues.push("decision mismatch");
}
if (report.summary.runtimeErrorCount !== 0) {
  issues.push(`runtimeErrorCount=${report.summary.runtimeErrorCount}`);
}
if (report.metrics.simulationRuns < 1000) {
  issues.push(`simulationRuns=${report.metrics.simulationRuns}`);
}
if (report.metrics.fullChainStageFailed !== 0 || report.metrics.fullChainFaultFailed !== 0) {
  issues.push("full-chain failures detected");
}
if (report.metrics.walkForwardTrades < 30) {
  issues.push(`walkForwardTrades=${report.metrics.walkForwardTrades}`);
}
if (!report.hardBlockers.some((item) => item.id === "risk:p95-drawdown-over-limit")) {
  issues.push("drawdown blocker missing");
}
if (!report.optimizations.some((item) => item.id === "pre-trade-risk-gate-send-path")) {
  issues.push("pre-trade risk gate optimization missing");
}
if (!report.optimizations.some((item) => item.id === "latency-gap-instrumentation")) {
  issues.push("latency/gap optimization missing");
}
if (report.safety.liveTradingEnabled !== false || report.safety.writeBrokerOrders !== false) {
  issues.push("live/write safety mismatch");
}
if (report.safety.sentOrder !== false || report.safety.paperOnly !== true) {
  issues.push("order safety mismatch");
}

if (issues.length > 0) {
  process.stderr.write(`CAPITAL_SIMULATION_DIAGNOSTICS_CHECK=FAIL issues=${issues.join(";")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `CAPITAL_SIMULATION_DIAGNOSTICS_CHECK=OK status=${report.status} runtimeErrors=${report.summary.runtimeErrorCount} blockers=${report.summary.hardBlockerCount} optimizations=${report.summary.optimizationCount} sentOrder=${report.safety.sentOrder}\n`,
  );
}
