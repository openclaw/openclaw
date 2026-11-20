import { sanitizeGoogleAssistantFirstOrdering as sanitizeGoogleTurnOrdering } from "../../shared/google-turn-ordering.js";
import type { AgentMessage } from "../runtime/index.js";
import { sanitizeToolUseResultPairingForModel } from "../session-transcript-repair.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "../tool-call-id.js";
import type { TranscriptPolicy } from "../transcript-policy.types.js";

function formatOpenAIResponsesReplayInvariantError(params: {
  reason: "dangling_tool_call" | "orphan_tool_result";
  toolCallId?: string;
  messageIndex: number;
}): Error {
  const toolCallId = params.toolCallId ? ` toolCallId=${params.toolCallId}` : "";
  return new Error(
    `invalid_replay_transcript: OpenAI Responses replay contains ${params.reason}${toolCallId} at message index ${params.messageIndex}`,
  );
}

function assertOpenAIResponsesToolUseResultInvariant(messages: AgentMessage[]): AgentMessage[] {
  const pending = new Map<string, number>();
  const assertNoPendingCalls = () => {
    const dangling = pending.entries().next().value;
    if (dangling) {
      throw formatOpenAIResponsesReplayInvariantError({
        reason: "dangling_tool_call",
        toolCallId: dangling[0],
        messageIndex: dangling[1],
      });
    }
  };

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const role = message?.role;

    if (role !== "toolResult") {
      assertNoPendingCalls();
    }

    if (!message || typeof message !== "object") {
      continue;
    }

    if (message.role === "toolResult") {
      const toolCallId = extractToolResultId(message);
      if (!toolCallId || !pending.delete(toolCallId)) {
        throw formatOpenAIResponsesReplayInvariantError({
          reason: "orphan_tool_result",
          ...(toolCallId ? { toolCallId } : {}),
          messageIndex: i,
        });
      }
      continue;
    }

    if (message.role !== "assistant") {
      continue;
    }

    for (const toolCall of extractToolCallsFromAssistant(message)) {
      pending.set(toolCall.id, i);
    }
  }

  assertNoPendingCalls();
  return messages;
}

/** Final generic invariants apply after provider hooks, or directly in native preparation. */
export function finishGenericReplayHistory(
  input: AgentMessage[],
  policy: TranscriptPolicy,
  modelApi?: string | null,
): AgentMessage[] {
  let messages = input;
  const isOpenAIResponsesApi =
    modelApi === "openai-responses" ||
    modelApi === "openai-chatgpt-responses" ||
    modelApi === "azure-openai-responses";
  if (isOpenAIResponsesApi) {
    if (policy.repairToolUseResultPairing) {
      messages = sanitizeToolUseResultPairingForModel(messages, true);
    }
    assertOpenAIResponsesToolUseResultInvariant(messages);
  }
  return policy.applyGoogleTurnOrdering ? sanitizeGoogleTurnOrdering(messages) : messages;
}
