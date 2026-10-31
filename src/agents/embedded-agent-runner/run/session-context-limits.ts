import type { SessionModelContextLimits } from "../../../config/sessions/session-history-read.types.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/** Attempts and recovery must hydrate the same bounded model-context view. */
export function resolveEmbeddedSessionContextLimits(
  params: Pick<EmbeddedRunAttemptParams, "contextTokenBudget" | "operation">,
): SessionModelContextLimits {
  return {
    maxBytes: Math.min(
      64 * 1024 * 1024,
      Math.max(1024, (params.contextTokenBudget ?? 128_000) * 8),
    ),
    maxEvents: 10_000,
    // The finalizer answers for this turn alone under its own cache key, so it trades
    // result bodies for the turn's request when screenshots fill the bound (#178300).
    ...(params.operation === "settled-tool-finalization"
      ? { toolResultOverflow: "omit" as const }
      : {}),
  };
}
