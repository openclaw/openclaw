import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Api, ToolCall } from "../types.js";
import { parseJsonObjectPreservingUnsafeIntegers } from "./json-unsafe-integers.js";
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

/** Replay original bytes only while the normalized arguments still match the saved call. */
export function replayOpenAIResponsesToolArguments(
  block: ToolCall,
  providerStyle: boolean,
  sameModel: boolean,
): string {
  const value = providerStyle
    ? JSON.stringify(block.arguments)
    : typeof block.arguments === "string"
      ? block.arguments
      : JSON.stringify(block.arguments ?? {});
  const signature = sameModel && block.argumentsSignature;
  return signature && signature.value === value && typeof signature.raw === "string"
    ? signature.raw
    : value;
}

/** New transcripts retain exact bytes; legacy callers may still replay normalized values. */
export function normalizeOpenAIResponsesToolArguments(value: unknown, replayed: unknown): unknown {
  if (isRecord(replayed) && replayed.arguments === value) {
    return value;
  }
  const args = parseJsonObjectPreservingUnsafeIntegers(value);
  return args ? JSON.stringify(args) : value;
}
