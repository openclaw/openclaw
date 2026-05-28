import { buildCapitalTelegramSemiApprovalGate } from "./openclaw-capital-telegram-semi-approval-gate.mjs";

const report = await buildCapitalTelegramSemiApprovalGate({
  repoRoot: process.cwd(),
  text: "模擬真單 台指近 多 1口",
});
const issues = [];
const isTrue = (value) => value === true;
const isFalse = (value) => value === false;
const safeStatuses = new Set([
  "semi_approval_pending_live_blocked",
  "semi_approval_ready_for_manual_review",
]);

if (report.schema !== "openclaw.capital.telegram-semi-approval-gate.v1") {
  issues.push("schema mismatch");
}
if (!safeStatuses.has(report.status)) {
  issues.push(`status=${report.status}`);
}
if (report.mode !== "telegram_semi_approval_dry_run_gate") {
  issues.push("mode mismatch");
}
if (report.input?.channel !== "telegram") {
  issues.push("telegram channel missing");
}
if (!isTrue(report.input?.parsed?.requiresSemiApproval)) {
  issues.push("SEMI approval requirement missing");
}
if (!Array.isArray(report.telegramUi?.buttons) || report.telegramUi.buttons.length < 3) {
  issues.push("telegram SEMI buttons missing");
}
if (report.telegramUi?.buttons?.some((button) => !isFalse(button.grantsLiveTrading))) {
  issues.push("telegram button grants live trading");
}
if (
  !report.route?.some(
    (step) => step.id === "telegram:semi-buttons-rendered" && step.status === "pass",
  )
) {
  issues.push("SEMI button render route missing");
}
const operatorConfirmationStep = report.route?.find(
  (step) => step.id === "telegram:operator-confirmation-state",
);
if (!operatorConfirmationStep || !["pending", "pass"].includes(operatorConfirmationStep.status)) {
  issues.push("operator confirmation route missing");
}
if (isTrue(report.approvalState?.manualOperatorConfirmed)) {
  if (operatorConfirmationStep?.status !== "pass") {
    issues.push("operator confirmation status should be pass after manual confirm");
  }
  if (report.blockers.includes("telegram:semi-human-confirmation-pending")) {
    issues.push("unexpected pending blocker after manual confirmation");
  }
} else {
  if (operatorConfirmationStep?.status !== "pending") {
    issues.push("operator confirmation pending route missing");
  }
  if (!report.blockers.includes("telegram:semi-human-confirmation-pending")) {
    issues.push("human confirmation blocker missing");
  }
}
if (
  !report.route?.some(
    (step) => step.id === "openclaw:live-promotion-remains-blocked" && step.status === "pass",
  )
) {
  issues.push("live promotion blocked route missing");
}
if (report.promotionGate?.status !== "blocked") {
  issues.push("promotion gate must remain blocked");
}
if (!isTrue(report.safety?.telegramDryRunOnly) || !isFalse(report.safety?.telegramMessageSent)) {
  issues.push("telegram dry-run safety mismatch");
}
if (!isFalse(report.safety?.liveTradingEnabled) || !isFalse(report.safety?.writeBrokerOrders)) {
  issues.push("live trading safety mismatch");
}
if (!isFalse(report.safety?.sentOrder) || !isTrue(report.safety?.doesNotSetHumanApproved)) {
  issues.push("order/human approval safety mismatch");
}
if (
  !/(等待 Telegram 人工確認|已可進入人工審查)/u.test(report.replyText) ||
  !/真單=仍?封鎖/u.test(report.replyText)
) {
  issues.push("reply text missing safety wording");
}

if (issues.length > 0) {
  process.stderr.write(
    `CAPITAL_TELEGRAM_SEMI_APPROVAL_GATE_CHECK=FAIL issues=${issues.join(";")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `CAPITAL_TELEGRAM_SEMI_APPROVAL_GATE_CHECK=OK status=${report.status} blockers=${report.blockers.join(",")} sentOrder=${report.safety.sentOrder} telegramMessageSent=${report.safety.telegramMessageSent}\n`,
  );
}
