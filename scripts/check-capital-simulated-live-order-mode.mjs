import { buildCapitalSimulatedLiveOrderMode } from "./openclaw-capital-simulated-live-order-mode.mjs";

const report = await buildCapitalSimulatedLiveOrderMode({ repoRoot: process.cwd() });
const issues = [];

if (report.schema !== "openclaw.capital.simulated-live-order-mode.v1") {
  issues.push("schema mismatch");
}
if (report.status !== "enabled_simulated_live") {
  issues.push(`status=${report.status}`);
}
if (report.mode !== "simulated_live_paper_only") {
  issues.push("mode mismatch");
}
if (report.safety.liveTradingEnabled) {
  issues.push("live trading must stay disabled");
}
if (report.safety.writeBrokerOrders) {
  issues.push("broker writes must stay disabled");
}
if (report.safety.brokerOrderPathEnabled) {
  issues.push("broker order path must stay disabled");
}
if (report.safety.sentOrder || !report.safety.noLiveOrderSent) {
  issues.push("sent order safety mismatch");
}
if (!report.safety.paperOnly) {
  issues.push("paperOnly must be true");
}
if (report.simulatedOrder?.routingDecision !== "paper-simulated") {
  issues.push("simulated order routing mismatch");
}
if (report.simulatedOrder?.brokerCommandSuppressed !== true) {
  issues.push("broker command must be suppressed");
}
if (
  !["SendFutureOrder", "SendOverseaFutureOrder"].includes(report.simulatedOrder?.wouldUseBrokerApi)
) {
  issues.push("broker api mapping missing");
}
if (Number(report.prerequisites.fullChainGate.runs ?? 0) < 1000) {
  issues.push("full chain 1000-run gate missing");
}
if (report.prerequisites.fullChainGate.status !== "passed") {
  issues.push("full chain gate not passed");
}
const livePromotion = report.prerequisites.livePromotion ?? {};
const livePromotionManualReviewReady =
  livePromotion.status === "live_ready" &&
  livePromotion.blockerCode === "LIVE_TRADING_MANUAL_REVIEW_REQUIRED";
const livePromotionBlocked = livePromotion.status === "blocked";
if (!livePromotionManualReviewReady && !livePromotionBlocked) {
  issues.push("live promotion must be blocked or manual-review ready");
}
if (Number(report.simulatedOrder?.accountAllowlist?.count ?? 0) <= 0) {
  issues.push("account allowlist summary missing");
}
if (report.blockers.length > 0) {
  issues.push(`blockers=${report.blockers.join(",")}`);
}

if (issues.length > 0) {
  process.stderr.write(`CAPITAL_SIMULATED_LIVE_ORDER_MODE_CHECK=FAIL issues=${issues.join(";")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `CAPITAL_SIMULATED_LIVE_ORDER_MODE_CHECK=OK status=${report.status} routing=${report.simulatedOrder.routingDecision} api=${report.simulatedOrder.wouldUseBrokerApi} sentOrder=${report.safety.sentOrder} accountAllowlistCount=${report.simulatedOrder.accountAllowlist.count}\n`,
  );
}
