import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCapitalLiveTradingHumanApproval } from "./openclaw-capital-live-trading-human-approval.mjs";
import { runCapitalLiveTradingPromotionGate } from "./openclaw-capital-live-trading-promotion-gate.mjs";

const repoRoot = process.cwd();
const sourceApprovalPath = path.join(repoRoot, "config", "capital-live-trading-approval.json");
const statePath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-trading-human-approval-request-latest.json",
);
const markdownPath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-trading-human-approval-request-latest.md",
);

const request = await runCapitalLiveTradingHumanApproval({
  action: "request",
  approvalPath: sourceApprovalPath,
  output: statePath,
  markdown: markdownPath,
  writeState: true,
});

assert.equal(request.schema, "openclaw.capital.live-trading-human-approval-request.v1");
assert.equal(request.status, "pending_manual_human_approval");
assert.ok(request.approvalToken.startsWith("approve-capital-live-"));
assert.ok(Array.isArray(request.accountAllowlist));
assert.ok(request.accountAllowlist.length > 0);
assert.equal(request.safety.liveTradingEnabled, false);
assert.equal(request.safety.writeBrokerOrders, false);
assert.equal(request.safety.sentOrder, false);
assert.equal(request.safety.doesNotSendOrder, true);
assert.match(request.commands.approveExample, /--write-approval/u);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capital-approval-"));
const fixtureApprovalPath = path.join(tempDir, "capital-live-trading-approval.fixture.json");
await fs.copyFile(sourceApprovalPath, fixtureApprovalPath);
const fixtureRequest = await runCapitalLiveTradingHumanApproval({
  action: "request",
  approvalPath: fixtureApprovalPath,
  output: path.join(tempDir, "approval-request.json"),
  markdown: path.join(tempDir, "approval-request.md"),
  writeState: true,
});

const approved = await runCapitalLiveTradingHumanApproval({
  action: "approve",
  approvalPath: fixtureApprovalPath,
  output: path.join(tempDir, "approval-request.json"),
  markdown: path.join(tempDir, "approval-request.md"),
  operator: "fixture-human-reviewer",
  rollbackPlan:
    "fixture rollback: disable live/write gates, stop service, verify no broker command files.",
  token: fixtureRequest.approvalToken,
  writeState: true,
  writeApproval: true,
});

assert.equal(approved.status, "manual_approve_written");
assert.equal(approved.approvalWrite.applied, true);
assert.equal(approved.approvalWrite.writesProductionApprovalFile, false);
assert.equal(approved.approvalWrite.humanApproved, true);
assert.equal(approved.approvalWrite.killSwitch, true);
assert.equal(approved.approvalWrite.rollbackPlanFilled, true);
assert.equal(approved.approvalWrite.liveTradingEnabled, false);
assert.equal(approved.approvalWrite.writeBrokerOrders, false);
assert.equal(approved.approvalWrite.sentOrder, false);

const fixtureApproval = JSON.parse(await fs.readFile(fixtureApprovalPath, "utf8"));
assert.equal(fixtureApproval.humanApproved, true);
assert.equal(fixtureApproval.manualAccountReviewRequired, false);
assert.equal(fixtureApproval.approvalStatus, "manual_approved_live_review_pending");
assert.equal(fixtureApproval.killSwitch, true);
assert.equal(fixtureApproval.reviewChecklist.manualOperatorConfirmed, true);
assert.equal(fixtureApproval.safety.allowLiveTrading, false);
assert.equal(fixtureApproval.safety.writeBrokerOrders, false);
assert.equal(fixtureApproval.safety.sentOrder, false);

const { report: promotion } = await runCapitalLiveTradingPromotionGate({
  approvalPath: fixtureApprovalPath,
  writeState: false,
});
assert.equal(promotion.status, "blocked");
assert.equal(promotion.liveTradingEnabled, false);
assert.equal(promotion.writeTradingEnabled, false);
assert.equal(promotion.sentOrder, false);
assert.equal(promotion.blockers.includes("live:human-approval-pending"), false);
assert.equal(promotion.blockers.includes("live:kill-switch-and-rollback"), false);

process.stdout.write(
  [
    "CAPITAL_LIVE_TRADING_HUMAN_APPROVAL_CHECK=OK",
    `requestStatus=${request.status}`,
    `fixtureApprovalStatus=${approved.status}`,
    `productionWrite=${approved.approvalWrite.writesProductionApprovalFile}`,
    `promotionStatus=${promotion.status}`,
    `blockers=${promotion.blockers.join(",")}`,
    "live/write/order=OFF",
  ].join("\n") + "\n",
);
