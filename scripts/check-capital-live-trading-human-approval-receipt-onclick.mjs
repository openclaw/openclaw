import assert from "node:assert/strict";
import path from "node:path";
import { runCapitalLiveTradingHumanApprovalReceiptOnclick } from "./openclaw-capital-live-trading-human-approval-receipt-onclick.mjs";

const repoRoot = process.cwd();
const stateDir = path.join(repoRoot, "reports", "hermes-agent", "state");

const report = await runCapitalLiveTradingHumanApprovalReceiptOnclick({
  action: "request",
  dryRun: true,
  telegramTarget: "capital-human-approval-receipt-dry-run-target",
  output: path.join(
    stateDir,
    "openclaw-capital-live-trading-human-approval-receipt-onclick-check.json",
  ),
  markdown: path.join(
    stateDir,
    "openclaw-capital-live-trading-human-approval-receipt-onclick-check.md",
  ),
  telegramReport: path.join(
    stateDir,
    "openclaw-capital-live-trading-human-approval-telegram-publish-check.json",
  ),
  summaryOutput: path.join(stateDir, "openclaw-capital-live-trading-approval-summary-check.json"),
  summaryMarkdown: path.join(stateDir, "openclaw-capital-live-trading-approval-summary-check.md"),
  approvalOutput: path.join(
    stateDir,
    "openclaw-capital-live-trading-human-approval-request-check.json",
  ),
  approvalMarkdown: path.join(
    stateDir,
    "openclaw-capital-live-trading-human-approval-request-check.md",
  ),
});

assert.equal(report.schema, "openclaw.capital.live-trading-human-approval-receipt-onclick.v1");
assert.equal(report.mode, "dry_run");
assert.ok(["dry_run_receipt_ready", "blocked"].includes(report.status));
assert.equal(report.safety.liveTradingEnabled, false);
assert.equal(report.safety.writeBrokerOrders, false);
assert.equal(report.safety.sentOrder, false);
assert.equal(report.safety.doesNotSendOrder, true);
assert.equal(report.safety.doesNotEnableBrokerWrite, true);
assert.equal(typeof report.checklist.verifyAccountAllowlist, "boolean");
assert.equal(typeof report.approval.commandPack.requestDryRun, "string");
assert.equal(typeof report.approval.commandPack.approveExecute, "string");
assert.equal(typeof report.approval.commandPack.denyExecute, "string");
assert.match(report.approval.commandPack.approveExecute, /--action approve/u);
assert.match(report.approval.commandPack.approveExecute, /--write-approval/u);
assert.match(report.approval.commandPack.denyExecute, /--action deny/u);
assert.match(report.approval.commandPack.currentAction, /--action request/u);
assert.equal(report.telegram.dryRun, true);
assert.equal(report.telegram.target, "capital-human-approval-receipt-dry-run-target");
assert.equal(report.telegram.status, "dry_run_ok");
assert.equal(report.telegram.commandExitCode, 0);
assert.match(report.summary.telegramSummary, /群益真單=封鎖/u);
assert.match(report.summary.telegramSummary, /live\/write\/order=OFF/u);

process.stdout.write(
  [
    "CAPITAL_LIVE_TRADING_HUMAN_APPROVAL_RECEIPT_ONCLICK_CHECK=OK",
    `status=${report.status}`,
    `mode=${report.mode}`,
    `telegramStatus=${report.telegram.status}`,
    `target=${report.telegram.target}`,
    "live/write/order=OFF",
  ].join("\n") + "\n",
);
