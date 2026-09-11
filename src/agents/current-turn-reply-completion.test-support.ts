import type { AgentRunTerminalReceipt } from "./agent-run-terminal-receipt.js";
import { createCurrentTurnDeliveryTool } from "./current-turn-delivery.js";
import {
  closeCurrentTurnReplyCompletionOwner,
  copyCurrentTurnReplyCompletion,
  createCurrentTurnReplyCompletionOwner,
} from "./current-turn-reply-completion.js";

export async function createSourceReplyReceiptFixture(
  status: "sent" | "partial_failed" | "forged",
  identity: { runId: string; sessionId: string; provider: string; model: string },
): Promise<Omit<AgentRunTerminalReceipt, "terminalDisposition">> {
  const { runId, sessionId, provider, model } = identity;
  const receipt = {
    runId,
    sessionId,
    turnId: runId,
    requested: { provider, model },
    effective: { provider, model, responseModel: model },
    successfulToolNames: [],
    rerouted: false,
    sourceReplyDelivered: status === "sent" ? (true as const) : undefined,
  };
  if (status === "forged") {
    return Object.assign(receipt, { completion: "ambiguous" });
  }
  const owner = createCurrentTurnReplyCompletionOwner();
  try {
    await createCurrentTurnDeliveryTool(
      {
        send: async () =>
          status === "sent"
            ? { status }
            : { status, sentBeforeError: true, error: "adapter acknowledgement lost" },
      },
      owner,
    ).execute("source-send", { text: "reply" });
    return copyCurrentTurnReplyCompletion(owner, receipt);
  } finally {
    closeCurrentTurnReplyCompletionOwner(owner);
  }
}
