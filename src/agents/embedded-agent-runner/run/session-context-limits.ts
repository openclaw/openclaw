import type { SessionModelContextLimits } from "../../../config/sessions/session-history-read.types.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const HISTORY_GUARD_BYTES = 16 * 1024 * 1024;

/**
 * Attempts and recovery hydrate all history since the latest compaction; only compaction moves
 * that window. This cap guards memory and stays below the smallest provider request-body limit
 * (Gemini inline data, 20 MB), since images count only ~2,000 tokens in the compaction estimate.
 */
export function resolveEmbeddedSessionContextLimits(
  params: Pick<EmbeddedRunAttemptParams, "contextTokenBudget" | "operation">,
): SessionModelContextLimits {
  if (params.operation === "settled-tool-finalization") {
    // The finalizer answers for this turn alone under its own cache key, so its request may be
    // cut without breaking any append-only prefix. It stays within eight bytes per budget token
    // and trades result bodies for the turn's request when screenshots fill it (#178300).
    return {
      maxBytes: Math.min(
        HISTORY_GUARD_BYTES,
        Math.max(1024, (params.contextTokenBudget ?? 128_000) * 8),
      ),
      maxEvents: 10_000,
      toolResultOverflow: "omit",
    };
  }
  return { maxBytes: HISTORY_GUARD_BYTES, maxEvents: 10_000 };
}
