import { buildCapitalMasterFlowChecklist } from "./openclaw-capital-master-flow-checklist.mjs";

const report = await buildCapitalMasterFlowChecklist({ repoRoot: process.cwd() });
const issues = [];

if (report.schema !== "openclaw.capital.master-flow-checklist.v1") {
  issues.push("schema mismatch");
}
if (!report.summary.rootOk) {
  issues.push("WRONG_PROJECT_ROOT");
}
if (!Array.isArray(report.flows) || report.flows.length < 10) {
  issues.push("flows checklist incomplete");
}
if (!Array.isArray(report.unfinished)) {
  issues.push("unfinished checklist missing");
}
if (
  report.unfinished.length === 0 &&
  (!Array.isArray(report.operationalBlockers) || report.operationalBlockers.length === 0)
) {
  issues.push("unfinished and operational blockers both missing");
}
if (!Array.isArray(report.liveOrderScope) || report.liveOrderScope.length < 5) {
  issues.push("live order scope missing");
}
if (!Array.isArray(report.operationalBlockers)) {
  issues.push("operational blockers missing");
}
if (!Array.isArray(report.excludedItems) || report.excludedItems.length === 0) {
  issues.push("excluded items missing");
}
if (
  report.unfinished.some((item) =>
    /stale callback|do_not_merge|blocked_runtime/u.test(String(item.item)),
  )
) {
  issues.push("wrong or runtime-only items leaked into actionable unfinished");
}
if (!report.flows.some((flow) => flow.id === "live-promotion" && flow.status === "blocked")) {
  issues.push("live promotion gate must remain blocked");
}
const serviceLoginFlow = report.flows.find((flow) => flow.id === "service-login");
if (!serviceLoginFlow) {
  issues.push("service-login flow missing");
} else {
  if (!report.summary.serviceRuntimeReady && serviceLoginFlow.status === "completed") {
    issues.push("service-login flow must not complete when service runtime is not ready");
  }
  if (!String(serviceLoginFlow.evidence || "").includes("liveness=")) {
    issues.push("service-login flow evidence must include liveness");
  }
}
if (!report.flows.some((flow) => flow.id === "thousand-run-simulation")) {
  issues.push("1000-run simulation flow missing");
}
if (!report.flows.some((flow) => flow.id === "full-chain-simulation")) {
  issues.push("full-chain simulation flow missing");
}
if (!report.flows.some((flow) => flow.id === "simulation-diagnostics")) {
  issues.push("simulation diagnostics flow missing");
}
if (!report.flows.some((flow) => flow.id === "simulated-live-order-mode")) {
  issues.push("simulated-live order mode flow missing");
}
if (!report.flows.some((flow) => flow.id === "live-order-dry-run-pretrade-gate")) {
  issues.push("live-order dry-run pretrade gate flow missing");
}
if (!report.flows.some((flow) => flow.id === "telegram-simulated-live-order")) {
  issues.push("telegram simulated-live order flow missing");
}
if (!report.flows.some((flow) => flow.id === "telegram-semi-approval-gate")) {
  issues.push("telegram SEMI approval gate flow missing");
}
if (!report.flows.some((flow) => flow.id === "telegram-semi-callback-handler")) {
  issues.push("telegram SEMI callback handler flow missing");
}
if (!report.flows.some((flow) => flow.id === "latency-gap-instrumentation")) {
  issues.push("latency/gap instrumentation flow missing");
}
if (!report.flows.some((flow) => flow.id === "overseas-product-rotation")) {
  issues.push("overseas product rotation flow missing");
}
if (!report.flows.some((flow) => flow.id === "qmd-walk-forward")) {
  issues.push("QMD walk-forward flow missing");
}
if (report.summary.thousandRunRecommendation == null) {
  issues.push("1000-run simulation summary missing");
}
if (report.summary.qmdWalkForwardStatus == null) {
  issues.push("QMD walk-forward summary missing");
}
if (!report.validationCommands.includes("pnpm capital:master-flow-checklist:check")) {
  issues.push("self validation command missing");
}
if (!report.validationCommands.includes("pnpm capital:simulation:1000:check")) {
  issues.push("1000-run simulation validation command missing");
}
if (!report.validationCommands.includes("pnpm capital:full-chain:check")) {
  issues.push("full-chain simulation validation command missing");
}
if (!report.validationCommands.includes("pnpm capital:simulation-diagnostics:check")) {
  issues.push("simulation diagnostics validation command missing");
}
if (!report.validationCommands.includes("pnpm capital:simulated-live:check")) {
  issues.push("simulated-live validation command missing");
}
if (!report.validationCommands.includes("pnpm capital:live-order-dry-run:check")) {
  issues.push("live-order dry-run validation command missing");
}
if (!report.validationCommands.includes("pnpm capital:telegram:simulated-live:check")) {
  issues.push("telegram simulated-live validation command missing");
}
if (!report.validationCommands.includes("pnpm capital:telegram:semi-approval:check")) {
  issues.push("telegram SEMI approval validation command missing");
}
if (!report.validationCommands.includes("pnpm capital:telegram:semi-callback:check")) {
  issues.push("telegram SEMI callback validation command missing");
}
if (!report.validationCommands.includes("pnpm capital:latency-gap:check")) {
  issues.push("latency/gap validation command missing");
}
if (!report.validationCommands.includes("pnpm capital:overseas-rotation:check")) {
  issues.push("overseas rotation validation command missing");
}
if (!report.validationCommands.includes("pnpm capital:walk-forward:qmd:check")) {
  issues.push("QMD walk-forward validation command missing");
}
if (!report.validationCommands.includes("pnpm capital:live-trading:approval:sync:check")) {
  issues.push("approval account sync validation command missing");
}

if (issues.length > 0) {
  process.stderr.write(`CAPITAL_MASTER_FLOW_CHECKLIST_CHECK=FAIL issues=${issues.join(";")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `CAPITAL_MASTER_FLOW_CHECKLIST_CHECK=OK flows=${report.flows.length} actionable=${report.unfinished.length} blockers=${report.operationalBlockers.length} excluded=${report.excludedItems.length} status=${report.status}\n`,
  );
}
