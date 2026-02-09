/**
 * Slack Approvals Poster
 *
 * Posts approval requests to #alfred-approvals channel
 * and monitors for user reactions to approve/reject model escalations.
 */

export interface ApprovalRequest {
  channel: string;
  message: string;
  sessionKey: string;
}

/**
 * Post approval request to #alfred-approvals channel.
 *
 * This is called from the approval interlay to notify the user
 * of a model divergence requiring approval. The message should include
 * reaction prompts (✅ for approve, ❌ for reject).
 *
 * In production, this integrates with OpenClaw's message broker
 * to post to the configured Slack channel.
 */
export async function postApprovalRequest(params: ApprovalRequest): Promise<void> {
  const { channel, message, sessionKey } = params;

  // In a real implementation, this would call OpenClaw's message broker
  // For now, we log the request so it can be picked up by the main gateway process
  console.log(
    JSON.stringify(
      {
        type: "approval-request",
        channel,
        message,
        sessionKey,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  // Signal to gateway/broker that this message should be posted
  // This will be picked up by the message routing system
  if (process.emit) {
    process.emit("approval-request", {
      channel,
      message,
      sessionKey,
    });
  }
}

/**
 * Monitor for approval reactions in #alfred-approvals.
 * Called from the main approval interlay to listen for user responses.
 */
export async function waitForApprovalReaction(params: {
  messageTs?: string;
  timeoutMs?: number;
}): Promise<"approve" | "reject" | "timeout"> {
  const { timeoutMs = 60_000 } = params;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve("timeout");
    }, timeoutMs);

    // Listen for approval reactions from message broker
    const handler = (reaction: { type: string; action: string }) => {
      if (reaction.type === "approval-reaction") {
        clearTimeout(timer);
        process.removeListener("message", handler as any);
        resolve(reaction.action === "approve" ? "approve" : "reject");
      }
    };

    if (process.on) {
      process.on("message", handler as any);
    }
  });
}
