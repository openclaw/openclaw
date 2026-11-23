import type { SessionModelContextLimits } from "../../../config/sessions/session-history-read.types.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/**
 * Attempts and recovery hydrate all history since the latest compaction; only compaction moves
 * that window. This cap guards memory and stays below the smallest provider request-body limit
 * (Gemini inline data, 20 MB), since images count only ~2,000 tokens in the compaction estimate.
 */
export function resolveEmbeddedSessionContextLimits(
  params: Pick<EmbeddedRunAttemptParams, "operation">,
): SessionModelContextLimits {
  return {
    maxBytes: 16 * 1024 * 1024,
    maxEvents: 10_000,
    // The finalizer answers for this turn alone under its own cache key, so it trades
    // result bodies for the turn's request when screenshots fill the bound (#178300).
    ...(params.operation === "settled-tool-finalization"
      ? { toolResultOverflow: "omit" as const }
      : {}),
  };
}
