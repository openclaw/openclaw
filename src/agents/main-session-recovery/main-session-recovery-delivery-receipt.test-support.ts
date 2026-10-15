import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";

export function createDeliveredReceiptEntry(
  context: SessionEntry["restartRecoveryDeliveryContext"],
  toolCallId = "message-call-1",
  sourceRunId = "discord-message-1",
): Partial<SessionEntry> {
  return {
    restartRecoveryDeliveryReceiptState: "delivered-terminal",
    restartRecoveryDeliveryToolCallId: toolCallId,
    restartRecoveryDeliveryRunId: "recovery-1",
    restartRecoveryDeliverySourceRunId: sourceRunId,
    restartRecoveryDeliveryContext: context,
  };
}
