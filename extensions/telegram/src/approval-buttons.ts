import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-runtime";
import type { TelegramInlineButtons } from "./button-types.js";

const MAX_CALLBACK_DATA_BYTES = 64;

function fitsCallbackData(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= MAX_CALLBACK_DATA_BYTES;
}

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
  const allowOnce = `/approve ${approvalId} allow-once`;
  if (!allowedDecisions.includes("allow-once") || !fitsCallbackData(allowOnce)) {
    return undefined;
  }

  const primaryRow: Array<{ text: string; callback_data: string }> = [
    { text: "Allow Once", callback_data: allowOnce },
  ];
  // Use a shorter decision alias so full plugin:<uuid> IDs still fit Telegram's
  // 64-byte callback_data limit for the "Allow Always" action.
  const allowAlways = `/approve ${approvalId} always`;
  if (allowedDecisions.includes("allow-always") && fitsCallbackData(allowAlways)) {
    primaryRow.push({ text: "Allow Always", callback_data: allowAlways });
  }
  const rows: Array<Array<{ text: string; callback_data: string }>> = [primaryRow];
  const deny = `/approve ${approvalId} deny`;
  if (allowedDecisions.includes("deny") && fitsCallbackData(deny)) {
    rows.push([{ text: "Deny", callback_data: deny }]);
  }
  return rows;
}
