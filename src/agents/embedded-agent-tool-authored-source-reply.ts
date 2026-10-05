/** Capture of replies authored by `canDeliverSourceReply` tools. */
import { extractToolAuthoredSourceReplyPayload } from "./embedded-agent-messaging-extraction.js";
import type { MessagingToolSourceReplyPayload } from "./embedded-agent-messaging.types.js";

/**
 * Reads the final reply a `canDeliverSourceReply` tool authored and keys it to its
 * tool call. The host delivers the payload and writes its transcript row after a
 * successful send, so nothing is persisted here. Callers must already have verified
 * the tool's capability, that the result is not an error, and that the call is a
 * direct model call rather than a nested program call. Returns undefined when the
 * result carries no deliverable reply.
 */
export function captureToolAuthoredSourceReply(params: {
  /** Effective tool result after hooks and middleware; only `details.sourceReply` is read. */
  result: unknown;
  toolCallId: string;
  /** Stable scope for the idempotency key: the run id, or the harness turn id without one. */
  idempotencyScope: string;
}): MessagingToolSourceReplyPayload | undefined {
  const extracted = extractToolAuthoredSourceReplyPayload(params.result);
  if (!extracted) {
    return undefined;
  }
  return {
    ...extracted,
    idempotencyKey:
      extracted.idempotencyKey ??
      `${params.idempotencyScope}:tool-source-reply:${params.toolCallId}`,
    sourceReplyFinal: true,
    toolAuthored: true,
  };
}
