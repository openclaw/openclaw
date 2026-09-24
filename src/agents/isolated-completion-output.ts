import type { AssistantMessage } from "../llm/types.js";
import { isTerminalAssistantError } from "../llm/utils/retry.js";
import {
  buildAssistantFailoverSignal,
  classifyAssistantFailoverReason,
} from "./embedded-agent-helpers/assistant-message-failures.js";

type IsolatedCompletionErrorCode =
  | "unsupported"
  | "runtime-unavailable"
  | "input-rejected"
  | "output-rejected";

export class IsolatedCompletionError extends Error {
  readonly code: IsolatedCompletionErrorCode;

  constructor(code: IsolatedCompletionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IsolatedCompletionError";
    this.code = code;
  }
}

export function hasCliSideEffectEvidence(result: {
  didSendViaMessagingTool?: boolean;
  didDeliverSourceReplyViaMessageTool?: boolean;
  messagingToolSentTexts?: unknown[];
  messagingToolSentMediaUrls?: unknown[];
  messagingToolSentTargets?: unknown[];
  messagingToolSourceReplyPayloads?: unknown[];
  acceptedSessionSpawns?: unknown[];
  successfulCronAdds?: number;
}): boolean {
  return Boolean(
    result.didSendViaMessagingTool ||
    result.didDeliverSourceReplyViaMessageTool ||
    result.messagingToolSentTexts?.length ||
    result.messagingToolSentMediaUrls?.length ||
    result.messagingToolSentTargets?.length ||
    result.messagingToolSourceReplyPayloads?.length ||
    result.acceptedSessionSpawns?.length ||
    result.successfulCronAdds,
  );
}

export function requireIsolatedAssistantText(assistant: AssistantMessage): string {
  if (assistant.stopReason !== "stop" && assistant.stopReason !== "length") {
    throw new IsolatedCompletionError(
      "output-rejected",
      `Isolated completion failed with stop reason ${assistant.stopReason}.`,
      assistant.stopReason === "error" && !isTerminalAssistantError(assistant)
        ? { cause: buildAssistantFailoverSignal(assistant) }
        : undefined,
    );
  }
  const textParts: string[] = [];
  for (const block of assistant.content) {
    if (block.type === "text") {
      textParts.push(block.text);
      continue;
    }
    if (block.type === "thinking") {
      continue;
    }
    throw new IsolatedCompletionError(
      "output-rejected",
      "Isolated completion returned a tool call; the result was rejected.",
    );
  }
  return textParts.join("").trim();
}

/** Account quota failures can rotate; terminal or tool-bearing output cannot be replayed. */
export function isRetryableIsolatedQuotaFailure(assistant: AssistantMessage): boolean {
  const reason = classifyAssistantFailoverReason(assistant);
  return (
    (reason === "rate_limit" || reason === "billing") &&
    assistant.content.every((block) => block.type === "text" || block.type === "thinking")
  );
}
