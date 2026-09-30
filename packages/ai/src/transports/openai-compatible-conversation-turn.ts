// Some providers require a non-empty user or assistant turn before submission.
import { hasNonEmptyString } from "@openclaw/normalization-core/string-coerce";

function hasNonEmptyContentPart(part: unknown): boolean {
  if (!part || typeof part !== "object") {
    return false;
  }
  const record = part as Record<string, unknown>;
  if (record.type === "text") {
    return hasNonEmptyString(record.text);
  }
  return true;
}

function hasNonEmptyMessageContent(content: unknown): boolean {
  if (hasNonEmptyString(content)) {
    return true;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(hasNonEmptyContentPart);
}

/** Returns whether an OpenAI-compatible messages payload contains a usable turn. */
export function hasOpenAICompatibleConversationTurn(messages: unknown): boolean {
  if (!Array.isArray(messages)) {
    return false;
  }
  return messages.some((message) => {
    if (!message || typeof message !== "object") {
      return false;
    }
    const record = message as Record<string, unknown>;
    if (record.role === "user") {
      return hasNonEmptyMessageContent(record.content);
    }
    if (record.role === "assistant") {
      if (hasNonEmptyMessageContent(record.content)) {
        return true;
      }
      const toolCalls = record.tool_calls;
      return (
        Array.isArray(toolCalls) &&
        toolCalls.some((toolCall) => toolCall && typeof toolCall === "object")
      );
    }
    return false;
  });
}
