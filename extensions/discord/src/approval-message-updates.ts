import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { parseExecApprovalData } from "./approval-custom-id.js";
import { parseCustomId } from "./internal/discord.js";

export const discordApprovalMessageUpdates = new KeyedAsyncQueue();

/** Read the current control identity, rather than reconstructing delivery ownership. */
export function hasDiscordApprovalControl(
  message: unknown,
  approval: NonNullable<ReturnType<typeof parseExecApprovalData>>,
): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  if ("custom_id" in message && typeof message.custom_id === "string") {
    const customId = parseCustomId(message.custom_id);
    const current = customId.key === "execapproval" ? parseExecApprovalData(customId.data) : null;
    return (
      current?.approvalId === approval.approvalId &&
      current.approvalKind === approval.approvalKind &&
      current.action === approval.action
    );
  }
  return (
    "components" in message &&
    Array.isArray(message.components) &&
    message.components.some((component: unknown) => hasDiscordApprovalControl(component, approval))
  );
}
