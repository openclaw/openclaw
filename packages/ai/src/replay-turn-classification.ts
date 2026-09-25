import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

type AssistantTurnLike = {
  role?: unknown;
  stopReason?: unknown;
  content?: unknown;
};

/** Returns true when an assistant turn contains only provider reasoning and blank text. */
export function hasOnlyAssistantReasoningContent(message: AssistantTurnLike): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const content = Array.isArray(message.content)
    ? message.content
    : message.content != null && typeof message.content === "object"
      ? [message.content]
      : [];
  let hasThinking = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      return false;
    }
    if (!("type" in block)) {
      return false;
    }
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      hasThinking = true;
      continue;
    }
    if (
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string" &&
      !block.text.trim()
    ) {
      continue;
    }
    return false;
  }
  return hasThinking;
}

/** Returns true when a token-limited turn contains only incomplete provider reasoning. */
export function isReasoningOnlyLengthAssistantTurn(message: AssistantTurnLike): boolean {
  return message.stopReason === "length" && hasOnlyAssistantReasoningContent(message);
}

// Legacy error content remains readable without replaying provider diagnostics.
export const STREAM_ERROR_FALLBACK_TEXT = "[assistant turn failed before producing content]";

export function isStreamErrorFallbackContent(content: unknown): boolean {
  if (content == null) {
    return true;
  }
  if (typeof content === "string") {
    return !content.trim() || content.trim() === STREAM_ERROR_FALLBACK_TEXT;
  }
  return (
    Array.isArray(content) &&
    content.every((value) => {
      const block = asOptionalRecord(value);
      return (
        block &&
        (block.type === "text" || block.type === "input_text" || block.type === "output_text") &&
        typeof block.text === "string" &&
        isStreamErrorFallbackContent(block.text)
      );
    })
  );
}

// Retain failed-turn identity without replaying unfinished provider output.
export const FAILED_ASSISTANT_REPLAY_TEXT =
  "[This turn failed before it completed. Do not redo its work without confirming with the user first.]";

type FailedAssistantReplay = "keep" | "drop" | "marker";

/** Classify failed source content before model-specific thinking or tool projection. */
export function resolveFailedAssistantReplay(
  message: AssistantTurnLike,
  options: { pairingAware: boolean },
): FailedAssistantReplay {
  if (
    message.role !== "assistant" ||
    (message.stopReason !== "error" && message.stopReason !== "aborted")
  ) {
    return "keep";
  }
  const content = Array.isArray(message.content) ? message.content : [];
  if (content.some((block) => asOptionalRecord(block)?.type === "toolCall")) {
    // Pairing repair needs the failed call and its owned results together.
    return options.pairingAware ? "keep" : "drop";
  }
  return content.some((block) => {
    const record = asOptionalRecord(block);
    return (
      record?.type === "text" &&
      typeof record.text === "string" &&
      !isStreamErrorFallbackContent(record.text)
    );
  })
    ? "marker"
    : "drop";
}
