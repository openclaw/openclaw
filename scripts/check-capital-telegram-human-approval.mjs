import assert from "node:assert/strict";
import { buildCapitalTelegramHumanApproval } from "./openclaw-capital-telegram-human-approval.mjs";

const report = await buildCapitalTelegramHumanApproval({
  repoRoot: process.cwd(),
  writeState: true,
  check: true,
});

assert.equal(report.schema, "openclaw.capital.telegram-human-approval.v1");
assert.equal(report.status, "telegram_human_approval_ready");
assert.equal(report.telegramUi.dryRunOnly, true);
assert.equal(report.telegramUi.messageSent, false);
assert.match(report.telegramUi.message, /群益真單人工核准請求/u);
assert.match(report.telegramUi.message, /live\/write\/order=OFF/u);
assert.equal(report.telegramUi.buttons.length, 3);
assert.equal(
  report.telegramUi.buttons.some((button) => button.grantsLiveTrading),
  false,
);
assert.equal(
  report.telegramUi.buttons.some((button) => button.grantsBrokerWrite),
  false,
);
assert.equal(
  report.telegramUi.buttons.some((button) => button.sendsOrder),
  false,
);
assert.equal(report.humanApprovalRequest.status, "pending_manual_human_approval");
assert.ok(report.humanApprovalRequest.approvalToken.startsWith("approve-capital-live-"));
assert.ok(report.humanApprovalRequest.accountAllowlistCount > 0);
assert.equal(typeof report.humanApprovalRequest.commandPack.requestDryRun, "string");
assert.equal(typeof report.humanApprovalRequest.commandPack.approveExecute, "string");
assert.equal(typeof report.humanApprovalRequest.commandPack.denyExecute, "string");
assert.match(report.humanApprovalRequest.commandPack.approveExecute, /--action approve/u);
assert.match(report.humanApprovalRequest.commandPack.approveExecute, /--write-approval/u);
assert.match(
  report.humanApprovalRequest.commandPack.approveExecute,
  /--token approve-capital-live-/u,
);
assert.match(report.humanApprovalRequest.commandPack.denyExecute, /--action deny/u);
assert.equal(report.callbackContract.approveRequiresOperator, true);
assert.equal(report.callbackContract.approveRequiresRollbackPlan, true);
assert.equal(report.callbackContract.enablesLiveTrading, false);
assert.equal(report.callbackContract.enablesBrokerWrite, false);
assert.equal(report.callbackContract.sendsOrder, false);
assert.equal(report.safety.liveTradingEnabled, false);
assert.equal(report.safety.writeBrokerOrders, false);
assert.equal(report.safety.sentOrder, false);

process.stdout.write(
  [
    "CAPITAL_TELEGRAM_HUMAN_APPROVAL_CHECK=OK",
    `status=${report.status}`,
    `accountAllowlist=${report.humanApprovalRequest.accountAllowlistCount}`,
    `buttons=${report.telegramUi.buttons.length}`,
    "live/write/order=OFF",
  ].join("\n") + "\n",
);
