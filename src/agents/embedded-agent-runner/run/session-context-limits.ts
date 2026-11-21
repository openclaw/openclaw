import type { SessionModelContextLimits } from "../../../config/sessions/session-history-read.types.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/** Attempts and recovery must hydrate the same bounded model-context view. */
export function resolveEmbeddedSessionContextLimits(
  params: Pick<EmbeddedRunAttemptParams, "contextTokenBudget">,
): SessionModelContextLimits {
  return {
    maxBytes: Math.min(
      64 * 1024 * 1024,
      Math.max(1024, (params.contextTokenBudget ?? 128_000) * 8),
    ),
    maxEvents: 10_000,
    // Stored screenshots cost far more bytes than model tokens, so they fill this bound long
    // before token compaction can run. Trading their bodies for notices keeps the conversation.
    // Accepted cost: above the bound, each newly omitted body changes the prompt prefix from
    // that message on; below it nothing is omitted (#159799).
    toolResultOverflow: "omit",
  };
}
