import type { Api } from "../types.js";
import type { ReplayableResponseReasoningItem } from "./openai-responses-contracts.js";

export function normalizeOpenAIResponsesReasoningReplayItem(
  item: ReplayableResponseReasoningItem,
  api: Api,
  provider: string,
): ReplayableResponseReasoningItem {
  if (api === "openai-chatgpt-responses") {
    return Array.isArray(item.summary) ? item : { ...item, summary: [] };
  }
  // Match storage's reasoning privacy shape and order before publishing or replaying.
  return {
    id: item.id,
    type: "reasoning",
    summary: [],
    // DeepSeek Responses requires plaintext reasoning on tool continuations.
    ...(Array.isArray(item.content) && (provider === "deepseek" || item.content.length === 0)
      ? { content: item.content }
      : {}),
    status: item.status,
    encrypted_content: item.encrypted_content,
  };
}
