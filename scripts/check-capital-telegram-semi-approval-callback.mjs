import fs from "node:fs/promises";
import path from "node:path";
import { buildCapitalTelegramSemiApprovalCallback } from "./openclaw-capital-telegram-semi-approval-callback.mjs";

const repoRoot = process.cwd();
const testApprovalPath = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-telegram-semi-approval-callback-test-approval.json",
);
const sourceApprovalPath = path.join(repoRoot, "config", "capital-live-trading-approval.json");
const sourceApproval = JSON.parse(
  (await fs.readFile(sourceApprovalPath, "utf8")).replace(/^\uFEFF/u, ""),
);
await fs.mkdir(path.dirname(testApprovalPath), { recursive: true });
await fs.writeFile(testApprovalPath, `${JSON.stringify(sourceApproval, null, 2)}\n`, "utf8");

const readyReport = await buildCapitalTelegramSemiApprovalCallback({
  repoRoot,
  action: "approve",
  approvalPath: testApprovalPath,
  writeReviewChecklist: false,
});
const approveCallbackData = readyReport.callback?.callbackData || "";
const writtenReport = await buildCapitalTelegramSemiApprovalCallback({
  repoRoot,
  action: "approve",
  callbackData: approveCallbackData,
  approvalPath: testApprovalPath,
  writeReviewChecklist: true,
  writeState: true,
});
const rejectReport = await buildCapitalTelegramSemiApprovalCallback({
  repoRoot,
  action: "reject",
  approvalPath: testApprovalPath,
  writeReviewChecklist: false,
});
const updatedApproval = JSON.parse(
  (await fs.readFile(testApprovalPath, "utf8")).replace(/^\uFEFF/u, ""),
);
const productionApproval = JSON.parse(
  (await fs.readFile(sourceApprovalPath, "utf8")).replace(/^\uFEFF/u, ""),
);
const issues = [];

if (readyReport.schema !== "openclaw.capital.telegram-semi-approval-callback.v1") {
  issues.push("schema mismatch");
}
if (readyReport.status !== "callback_review_checklist_ready") {
  issues.push(`ready status=${readyReport.status}`);
}
if (writtenReport.status !== "callback_review_checklist_written") {
  issues.push(`written status=${writtenReport.status}`);
}
if (rejectReport.status !== "callback_review_checklist_ready") {
  issues.push(`reject status=${rejectReport.status}`);
}
if (
  !writtenReport.callback?.matched ||
  writtenReport.callback?.button?.action !== "approve_paper_simulated"
) {
  issues.push("approve callback not matched");
}
if (!approveCallbackData) {
  issues.push("approve callback data missing");
}
if (rejectReport.callback?.button?.action !== "reject_paper_simulated") {
  issues.push("reject callback not matched");
}
if (writtenReport.reviewChecklistPatch?.manualOperatorConfirmed !== true) {
  issues.push("manualOperatorConfirmed patch missing");
}
if (updatedApproval.reviewChecklist?.manualOperatorConfirmed !== true) {
  issues.push("test approval reviewChecklist not written");
}
if (updatedApproval.reviewChecklist?.telegramNotificationVerified !== true) {
  issues.push("telegramNotificationVerified not written");
}
if (updatedApproval.humanApproved !== false) {
  issues.push("test approval humanApproved changed");
}
if (
  updatedApproval.safety?.allowLiveTrading !== false ||
  updatedApproval.safety?.writeBrokerOrders !== false
) {
  issues.push("test approval live/write enabled");
}
if (updatedApproval.safety?.sentOrder !== false) {
  issues.push("test approval sentOrder changed");
}
if (productionApproval.humanApproved !== sourceApproval.humanApproved) {
  issues.push("production approval humanApproved mutated");
}
if (
  productionApproval.reviewChecklist?.manualOperatorConfirmed !==
  sourceApproval.reviewChecklist?.manualOperatorConfirmed
) {
  issues.push("production approval reviewChecklist mutated");
}
if (writtenReport.promotionGate?.status !== "blocked") {
  issues.push("promotion gate must remain blocked");
}
if ((writtenReport.safety?.sentOrder ?? true) || !writtenReport.safety?.doesNotSetHumanApproved) {
  issues.push("callback safety mismatch");
}
if (!/真單=封鎖/u.test(writtenReport.replyText)) {
  issues.push("reply text missing live block wording");
}

if (issues.length > 0) {
  process.stderr.write(
    `CAPITAL_TELEGRAM_SEMI_APPROVAL_CALLBACK_CHECK=FAIL issues=${issues.join(";")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `CAPITAL_TELEGRAM_SEMI_APPROVAL_CALLBACK_CHECK=OK status=${writtenReport.status} action=${writtenReport.callback.button.action} testManualOperatorConfirmed=${updatedApproval.reviewChecklist.manualOperatorConfirmed} productionMutated=false sentOrder=${writtenReport.safety.sentOrder}\n`,
  );
}
