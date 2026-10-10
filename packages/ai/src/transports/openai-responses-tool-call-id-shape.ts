/**
 * Pure OpenAI Responses `call_*`/`fc_*` tool-call-id shape helpers.
 *
 * Moved out of embedded-agent-helpers/openai.ts (the AgentMessage[]-walking
 * caller lives in src/agents and imports from packages/ai, so the reverse
 * import direction is not available) so the continuation transport can
 * recognize its own cached raw ids after this same reshaping and restore
 * them on a replayed wire request -- see openai-responses-continuation.ts.
 */
import { sha256Hex } from "./transport-utils.js";

export const OPENAI_RESPONSES_ID_MAX_LENGTH = 64;
export const OPENAI_RESPONSES_CALL_ID_RE = /^call_[A-Za-z0-9_-]{1,59}$/;
export const OPENAI_RESPONSES_FUNCTION_CALL_ITEM_ID_RE = /^fc_[A-Za-z0-9_-]{1,61}$/;

export function splitOpenAIFunctionCallPairing(id: string): {
  callId: string;
  itemId?: string;
} {
  const separator = id.indexOf("|");
  if (separator <= 0 || separator >= id.length - 1) {
    return { callId: id };
  }
  return {
    callId: id.slice(0, separator),
    itemId: id.slice(separator + 1),
  };
}

function normalizeOpenAIResponsesIdPart(value: string, prefix: "call_" | "fc_"): string {
  const trimmed = value.trim();
  const pattern =
    prefix === "call_" ? OPENAI_RESPONSES_CALL_ID_RE : OPENAI_RESPONSES_FUNCTION_CALL_ITEM_ID_RE;
  if (pattern.test(trimmed)) {
    return trimmed;
  }

  const rawTail = trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
  const hash = sha256Hex(trimmed || prefix).slice(0, 10);
  const maxTailLength = OPENAI_RESPONSES_ID_MAX_LENGTH - prefix.length;
  const hashSuffix = `_${hash}`;
  const safeTail = rawTail.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  const clippedBase = safeTail.slice(0, Math.max(1, maxTailLength - hashSuffix.length));
  const tail = `${clippedBase || "id"}${hashSuffix}`.slice(0, maxTailLength);
  return `${prefix}${tail}`;
}

/** Same shaping `normalizeOpenAIResponsesToolCallIds` applies to a replayed `call_id`/`call_id|fc_id` pair. */
export function normalizeOpenAIResponsesFunctionCallId(id: string): string {
  const { callId, itemId } = splitOpenAIFunctionCallPairing(id);
  const normalizedCallId = normalizeOpenAIResponsesIdPart(
    itemId ? `${callId}|${itemId}` : callId,
    "call_",
  );

  if (!itemId) {
    return normalizedCallId;
  }

  const normalizedItemId = normalizeOpenAIResponsesIdPart(itemId, "fc_");
  return `${normalizedCallId}|${normalizedItemId}`;
}

export function shouldNormalizeOpenAIResponsesToolCallId(id: string): boolean {
  const pairing = splitOpenAIFunctionCallPairing(id);
  if (!OPENAI_RESPONSES_CALL_ID_RE.test(pairing.callId)) {
    return true;
  }
  if (pairing.itemId === undefined) {
    return false;
  }
  return !OPENAI_RESPONSES_FUNCTION_CALL_ITEM_ID_RE.test(pairing.itemId);
}
