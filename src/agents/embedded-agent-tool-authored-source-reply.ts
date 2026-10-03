/** Transcript persistence for replies authored by `canDeliverSourceReply` tools. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { MessagingToolSourceReplyPayload } from "./embedded-agent-messaging.types.js";

const loadInternalSourceReplyPersistence = createLazyRuntimeModule(
  () => import("../gateway/internal-source-reply-persistence.js"),
);

export type ToolAuthoredSourceReplyPersistenceParams = {
  cfg?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  runId?: string;
  toolName: string;
  toolCallId: string;
  payload: MessagingToolSourceReplyPayload;
  idempotencyKey: string;
  sourceReplyFinal: boolean;
  log?: { warn: (message: string) => void };
};

/** Builds the idempotency key that ties a tool-authored reply to its tool call. */
export function buildToolAuthoredSourceReplyIdempotencyKey(params: {
  runId: string;
  toolCallId: string;
}): string {
  return `${params.runId}:tool-source-reply:${params.toolCallId}`;
}

/**
 * Records a tool-authored source reply as the run's assistant turn before the host
 * delivers it, so the next turn's context shows what the user actually received.
 * Delivery does not depend on this write; a failure only costs the transcript row.
 */
export async function persistToolAuthoredSourceReply(
  params: ToolAuthoredSourceReplyPersistenceParams,
): Promise<boolean> {
  if (!params.cfg || !params.sessionKey) {
    params.log?.warn(
      `tool-authored source reply not persisted (missing session context): tool=${params.toolName}`,
    );
    return false;
  }
  try {
    const { persistInternalSourceReply } = await loadInternalSourceReplyPersistence();
    await persistInternalSourceReply({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      expectedSessionId: params.sessionId,
      agentId: params.agentId,
      payload: {
        ...(params.payload.text ? { text: params.payload.text } : {}),
        ...(params.payload.mediaUrl ? { mediaUrl: params.payload.mediaUrl } : {}),
        ...(params.payload.mediaUrls?.length ? { mediaUrls: params.payload.mediaUrls } : {}),
        ...(params.payload.attachments?.length ? { attachments: params.payload.attachments } : {}),
        ...(params.payload.channelData ? { channelData: params.payload.channelData } : {}),
      },
      idempotencyKey: params.idempotencyKey,
      runId: params.runId,
      sourceReplyFinal: params.sourceReplyFinal,
      toolCallId: params.toolCallId,
    });
    return true;
  } catch (error) {
    params.log?.warn(
      `tool-authored source reply not persisted: tool=${params.toolName} error=${String(error)}`,
    );
    return false;
  }
}
