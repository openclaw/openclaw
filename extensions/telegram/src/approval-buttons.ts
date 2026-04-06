import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import { sanitizeTelegramCallbackData } from "./approval-callback-data.js";
import type { TelegramInlineButtons } from "./button-types.js";

export function buildTelegramExecApprovalButtons(
  approvalId: string,
): TelegramInlineButtons | undefined {
  return buildTelegramExecApprovalButtonsForDecisions(approvalId, [
    "allow-once",
    "allow-always",
    "deny",
  ]);
}

function buildTelegramExecApprovalButtonsForDecisions(
  approvalId: string,
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): TelegramInlineButtons | undefined {
  const allowOnce = sanitizeTelegramCallbackData(`/approve ${approvalId} allow-once`);
  if (!allowedDecisions.includes("allow-once") || !allowOnce) {
    return undefined;
  }

  const primaryRow: Array<{ text: string; callback_data: string }> = [
    { text: "Allow Once", callback_data: allowOnce },
  ];
  const allowAlways = sanitizeTelegramCallbackData(`/approve ${approvalId} allow-always`);
  if (allowedDecisions.includes("allow-always") && allowAlways) {
    primaryRow.push({ text: "Allow Always", callback_data: allowAlways });
  }
  const rows: Array<Array<{ text: string; callback_data: string }>> = [primaryRow];
  const deny = sanitizeTelegramCallbackData(`/approve ${approvalId} deny`);
  if (allowedDecisions.includes("deny") && deny) {
    rows.push([{ text: "Deny", callback_data: deny }]);
  }
  return rows;
}
