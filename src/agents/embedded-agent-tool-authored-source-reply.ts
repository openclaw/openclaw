/** Capture and transcript persistence for replies authored by `canDeliverSourceReply` tools. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import {
  extractToolAuthoredSourceReplyPayload,
  resolveToolAuthoredSourceReplyFinal,
} from "./embedded-agent-messaging-extraction.js";
import type { MessagingToolSourceReplyPayload } from "./embedded-agent-messaging.types.js";

const loadInternalSourceReplyPersistence = createLazyRuntimeModule(
  () => import("../gateway/internal-source-reply-persistence.js"),
);

export type CaptureToolAuthoredSourceReplyParams = {
  /** Executed tool result; only `details.sourceReply` is read. */
  result: unknown;
  toolName: string;
  toolCallId: string;
  /** Stable scope for the idempotency key: the run id, or the harness turn id without one. */
  idempotencyScope: string;
  cfg?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  runId?: string;
  log?: { warn: (message: string) => void };
};

export type CapturedToolAuthoredSourceReply = {
  /** Deliverable payload, marked `toolAuthored` with its idempotency key and finality. */
  payload: MessagingToolSourceReplyPayload;
  /** Transcript write; delivery never waits on it and a failure is only logged. */
  persistence: Promise<boolean>;
};

/**
 * Reads the reply a `canDeliverSourceReply` tool authored and records it as the run's
 * assistant turn, so the next turn's context shows what the user actually received.
 * Callers must already have verified the tool's capability and that the result is not
 * an error. Returns undefined when the result carries no visible reply.
 */
export function captureToolAuthoredSourceReply(
  params: CaptureToolAuthoredSourceReplyParams,
): CapturedToolAuthoredSourceReply | undefined {
  const extracted = extractToolAuthoredSourceReplyPayload(params.result);
  if (!extracted) {
    return undefined;
  }
  const payload: MessagingToolSourceReplyPayload = {
    ...extracted,
    idempotencyKey:
      extracted.idempotencyKey ??
      `${params.idempotencyScope}:tool-source-reply:${params.toolCallId}`,
    sourceReplyFinal: resolveToolAuthoredSourceReplyFinal(params.result),
  };
  return { payload, persistence: persistToolAuthoredSourceReply(params, payload) };
}

async function persistToolAuthoredSourceReply(
  params: CaptureToolAuthoredSourceReplyParams,
  payload: MessagingToolSourceReplyPayload,
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
        ...(payload.text ? { text: payload.text } : {}),
        ...(payload.mediaUrl ? { mediaUrl: payload.mediaUrl } : {}),
        ...(payload.mediaUrls?.length ? { mediaUrls: payload.mediaUrls } : {}),
        ...(payload.attachments?.length ? { attachments: payload.attachments } : {}),
        ...(payload.channelData ? { channelData: payload.channelData } : {}),
      },
      idempotencyKey: payload.idempotencyKey,
      runId: params.runId,
      sourceReplyFinal: payload.sourceReplyFinal,
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
