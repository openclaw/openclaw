import type { Api } from "../types.js";
import type { ReplayableResponseReasoningItem } from "./openai-responses-contracts.js";

/** Resolves the assistant message id that can be replayed to OpenAI Responses. */
export function resolveReplayableResponsesMessageId(params: {
  replayResponsesItemIds: boolean;
  textSignatureId?: string;
  fallbackId: string;
  fallbackOrdinal: number;
  previousReplayItemWasReasoning: boolean;
}): string | undefined {
  if (!params.replayResponsesItemIds) {
    return undefined;
  }
  if (!params.textSignatureId) {
    // Id-less text signatures get a deterministic synthetic id per fallback
    // ordinal; signed text can only replay when paired with preceding reasoning.
    return params.fallbackOrdinal === 0
      ? params.fallbackId
      : `${params.fallbackId}_${params.fallbackOrdinal}`;
  }
  return params.previousReplayItemWasReasoning ? params.textSignatureId : undefined;
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
    status: item.status,
    encrypted_content: item.encrypted_content,
  };
}
