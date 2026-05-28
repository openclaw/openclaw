import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCapitalTelegramHumanApprovalCallback } from "./openclaw-capital-telegram-human-approval-callback.mjs";

const tempDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "openclaw-capital-telegram-human-approval-check-"),
);
const fixtureApprovalPath = path.join(tempDir, "capital-live-trading-approval.fixture.json");
await fs.copyFile(
  path.join(process.cwd(), "config", "capital-live-trading-approval.json"),
  fixtureApprovalPath,
);

const report = await buildCapitalTelegramHumanApprovalCallback({
  repoRoot: process.cwd(),
  action: "approve",
  approvalPath: fixtureApprovalPath,
  operator: "fixture-telegram-human-reviewer",
  rollbackPlan:
    "fixture rollback: keep allowLiveTrading/writeBrokerOrders false and verify no broker command was written.",
  writeApproval: true,
  check: true,
  writeState: true,
});

assert.equal(report.schema, "openclaw.capital.telegram-human-approval-callback.v1");
assert.equal(report.status, "telegram_human_approval_callback_ready");
assert.equal(report.scope.productionApprovalWrite, false);
assert.equal(report.callback.action, "approve");
assert.equal(typeof report.callback.commandPack.currentAction, "string");
assert.equal(typeof report.callback.commandPack.approveExecute, "string");
assert.equal(typeof report.callback.commandPack.denyExecute, "string");
assert.match(report.callback.commandPack.currentAction, /--action approve/u);
assert.match(report.callback.commandPack.currentAction, /--write-approval/u);
assert.match(report.callback.commandPack.approveExecute, /--action approve/u);
assert.match(report.callback.commandPack.denyExecute, /--action deny/u);
assert.equal(report.callbackExecutionSummary.requestedAction, "approve");
assert.equal(report.callbackExecutionSummary.approvalStatus, report.approvalResult.status);
assert.equal(report.callbackExecutionSummary.approvalApplied, true);
assert.equal(report.callbackExecutionSummary.manualApprovalStatus, "manual_approved_written");
assert.equal(report.callbackExecutionSummary.liveWriteOrderLocked, true);
assert.equal(typeof report.telegramReply.textSummaryZhTw, "string");
assert.equal(report.telegramReply.includesActionResult, true);
assert.equal(report.telegramReply.includesPromotionResult, true);
assert.equal(report.telegramReply.includesSafetyLock, true);
assert.match(report.telegramReply.textSummaryZhTw, /動作=approve/u);
assert.match(report.telegramReply.textSummaryZhTw, /live\/write\/order=OFF/u);
assert.match(
  report.telegramReply.textSummaryZhTw,
  /promotion=blocked\/LIVE_TRADING_MANUAL_REVIEW_REQUIRED/u,
);
assert.equal(report.approvalResult.applied, true);
assert.equal(report.approvalResult.humanApproved, true);
assert.equal(report.approvalResult.killSwitch, true);
assert.equal(report.approvalResult.rollbackPlanFilled, true);
assert.equal(report.approvalResult.writesProductionApprovalFile, false);
assert.equal(report.promotionGate.status, "blocked");
assert.equal(report.promotionGate.sentOrder, false);
assert.equal(report.safety.liveTradingEnabled, false);
assert.equal(report.safety.writeBrokerOrders, false);
assert.equal(report.safety.sentOrder, false);
assert.equal(report.safety.doesNotEnableLiveTrading, true);
assert.equal(report.safety.doesNotSendOrder, true);

process.stdout.write(
  [
    "CAPITAL_TELEGRAM_HUMAN_APPROVAL_CALLBACK_CHECK=OK",
    `status=${report.status}`,
    `applied=${report.approvalResult.applied}`,
    `productionWrite=${report.scope.productionApprovalWrite}`,
    `promotionStatus=${report.promotionGate.status}`,
    "live/write/order=OFF",
  ].join("\n") + "\n",
);
