import { buildCapitalTelegramSimulatedLiveOrder } from "./openclaw-capital-telegram-simulated-live-order.mjs";

const report = await buildCapitalTelegramSimulatedLiveOrder({
  repoRoot: process.cwd(),
  text: "模擬真單 台指近 多 1口",
});
const issues = [];

if (report.schema !== "openclaw.capital.telegram-simulated-live-order.v1") {
  issues.push("schema mismatch");
}
if (report.status !== "telegram_simulated_live_ready") {
  issues.push(`status=${report.status}`);
}
if (report.mode !== "telegram_simulated_live_paper_only") {
  issues.push("mode mismatch");
}
if (report.input?.channel !== "telegram") {
  issues.push("telegram channel missing");
}
if (!report.input?.parsed?.intentDetected) {
  issues.push("telegram intent not detected");
}
if (
  !report.route?.some(
    (step) => step.id === "telegram:semi-approval-required" && step.status === "pass",
  )
) {
  issues.push("SEMI approval simulation missing");
}
if (report.simulatedLive?.routingDecision !== "paper-simulated") {
  issues.push("simulated-live routing mismatch");
}
if (!report.simulatedLive?.brokerCommandSuppressed) {
  issues.push("broker command not suppressed");
}
if (!report.safety?.telegramDryRunOnly || report.safety?.telegramMessageSent) {
  issues.push("telegram dry-run safety mismatch");
}
if (report.safety?.writeBrokerOrders || report.safety?.sentOrder) {
  issues.push("broker write/order safety mismatch");
}
if (!/Telegram 模擬真單/u.test(report.replyText) || !/真單=封鎖/u.test(report.replyText)) {
  issues.push("reply text missing safety wording");
}
if (report.blockers.length > 0) {
  issues.push(`blockers=${report.blockers.join(",")}`);
}

if (issues.length > 0) {
  process.stderr.write(
    `CAPITAL_TELEGRAM_SIMULATED_LIVE_ORDER_CHECK=FAIL issues=${issues.join(";")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `CAPITAL_TELEGRAM_SIMULATED_LIVE_ORDER_CHECK=OK status=${report.status} route=${report.simulatedLive.routingDecision} sentOrder=${report.safety.sentOrder} telegramMessageSent=${report.safety.telegramMessageSent}\n`,
  );
}
