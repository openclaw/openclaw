/**
 * Detects provider stop turns that contain no assistant-visible content.
 */
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";

type EmptyAssistantTurnLike = {
  content?: unknown;
  stopReason?: unknown;
  usage?: unknown;
};

// Upstream agent runtimes should normalize Anthropic zero-token empty `stop`
// turns before OpenClaw sees them. Downstream: openclaw/openclaw#71880.
function hasZeroTokenUsageSnapshot(usage: unknown): boolean {
  const fields = asOptionalObjectRecord(usage);
  if (!fields) {
    return false;
  }
  const counts = [
    fields.input,
    fields.output,
    fields.cacheRead,
    fields.cacheWrite,
    fields.total ?? fields.totalTokens ?? fields.total_tokens,
  ].map(asFiniteNumber);
  return (
    counts.some((count) => count === 0) &&
    counts.every((count) => count === undefined || count === 0)
  );
}

export function isZeroUsageEmptyStopAssistantTurn(message: EmptyAssistantTurnLike | null): boolean {
  return Boolean(
    message &&
    message.stopReason === "stop" &&
    Array.isArray(message.content) &&
    message.content.length === 0 &&
    hasZeroTokenUsageSnapshot(message.usage),
  );
}
