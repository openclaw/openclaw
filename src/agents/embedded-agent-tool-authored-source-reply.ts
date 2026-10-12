/** Capture of replies authored by `canDeliverSourceReply` tools. */
import { resolveAgentAssistantTurnId } from "../../packages/agent-core/src/tool-execution-context.js";
import type { AssistantMessage } from "../llm/types.js";
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
  /** Stable scope: the issuing assistant turn, else the run id or harness turn id. */
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
    toolAuthoredForToolCallId: params.toolCallId,
  };
}

/** Matches the final assistant for one input, never an attempt-wide presence flag. */
export function isToolAuthoredSourceReplyForAssistant(
  payload: MessagingToolSourceReplyPayload,
  assistant: AssistantMessage | null | undefined,
): boolean {
  return (
    payload.toolAuthored === true &&
    Boolean(
      assistant &&
      assistant.stopReason !== "error" &&
      assistant.stopReason !== "aborted" &&
      (payload.toolAuthoredForTurnId
        ? payload.toolAuthoredForTurnId === resolveAgentAssistantTurnId(assistant)
        : assistant.content.some(
            (block) => block.type === "toolCall" && block.id === payload.toolAuthoredForToolCallId,
          )),
    )
  );
}
