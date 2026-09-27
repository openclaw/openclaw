import { readSessionTranscriptModelContextAsync } from "../../../config/sessions/session-transcript-read-worker-runtime.js";
import { readMessageIdempotencyKey } from "../../../config/sessions/transcript-message-identity.js";
import type { AgentMessage } from "../../runtime/index.js";
import { SessionManager, type AgentSession } from "../../sessions/index.js";
import { resolveEmbeddedSessionContextLimits } from "./session-context-limits.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/** Read the accepted prefix separately from this logical turn's retained evidence. */
type ContinuationInput = Pick<
  EmbeddedRunAttemptParams,
  "continuationMessages" | "pluginRuntimeRefreshMessages" | "userTurnTranscriptRecorder"
>;

export async function readEmbeddedContinuationPrefix(
  params: ContinuationInput & Pick<EmbeddedRunAttemptParams, "abortSignal" | "contextTokenBudget">,
) {
  const admission = params.userTurnTranscriptRecorder?.getAdmissionReceipt();
  const messages = params.continuationMessages ?? params.pluginRuntimeRefreshMessages;
  if (!messages) {
    return undefined;
  }
  if (!admission) {
    return { prefix: undefined, currentTurnMessages: messages };
  }
  const context = await readSessionTranscriptModelContextAsync(
    {
      agentId: admission.agentId,
      sessionId: admission.sessionId,
      sessionKey: admission.sessionKey,
      storePath: admission.storePath,
    },
    admission,
    params.abortSignal,
    undefined,
    resolveEmbeddedSessionContextLimits(params.contextTokenBudget),
  );
  params.abortSignal?.throwIfAborted();
  return {
    prefix: SessionManager.fromEntries(context.events).buildSessionContext().messages,
    currentTurnMessages: messages,
  };
}

/** Retain settled model evidence independently of compaction's history window. */
export function captureEmbeddedAttemptContinuation(
  params: ContinuationInput & Pick<EmbeddedRunAttemptParams, "captureContinuationMessages">,
  session: AgentSession,
) {
  const messages: AgentMessage[] = [];
  const unsubscribe = params.captureContinuationMessages
    ? session.subscribe((event) => {
        if (
          event.type === "message_end" &&
          (event.message.role === "user" ||
            event.message.role === "assistant" ||
            event.message.role === "toolResult")
        ) {
          messages.push(event.message);
        }
      })
    : undefined;
  return {
    close: () => unsubscribe?.(),
    read: () => {
      if (!params.captureContinuationMessages) {
        return undefined;
      }
      const original = params.userTurnTranscriptRecorder?.getPersistedMessage?.();
      if (!original || (params.continuationMessages ?? params.pluginRuntimeRefreshMessages)) {
        return messages;
      }
      const identity = readMessageIdempotencyKey(original);
      return [
        original,
        ...messages.filter(
          (message) =>
            message !== original && (!identity || readMessageIdempotencyKey(message) !== identity),
        ),
      ];
    },
  };
}
