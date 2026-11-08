import type { Api } from "../types.js";
import type { ReplayableResponseReasoningItem } from "./openai-responses-contracts.js";

type ReasoningContentPart = NonNullable<ReplayableResponseReasoningItem["content"]>[number];

/**
 * Keeps plaintext reasoning parts that some providers (for example DeepSeek)
 * require echoed back on the next turn. The text is already carried by the
 * thinking block itself, so this adds no new transcript exposure.
 */
export function projectReasoningTextParts(
  content: readonly ReasoningContentPart[],
): ReasoningContentPart[] {
  return content.filter((part) => part?.type === "reasoning_text" && typeof part.text === "string");
}

export function normalizeOpenAIResponsesReasoningReplayItem(
  item: ReplayableResponseReasoningItem,
  api: Api,
): ReplayableResponseReasoningItem {
  if (api === "openai-chatgpt-responses") {
    return Array.isArray(item.summary) ? item : { ...item, summary: [] };
  }
  // Match storage's reasoning privacy shape and order before publishing or replaying.
  return {
    id: item.id,
    type: "reasoning",
    summary: [],
    ...(Array.isArray(item.content) ? { content: projectReasoningTextParts(item.content) } : {}),
    status: item.status,
    encrypted_content: item.encrypted_content,
  };
}
