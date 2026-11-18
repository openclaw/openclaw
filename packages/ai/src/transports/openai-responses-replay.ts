import type { Api } from "../types.js";
import type { ReplayableResponseReasoningItem } from "./openai-responses-contracts.js";

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
    ...(Array.isArray(item.content) && item.content.length === 0 ? { content: [] } : {}),
    status: item.status,
    encrypted_content: item.encrypted_content,
  };
}
