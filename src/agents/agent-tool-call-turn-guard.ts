/**
 * Phase 8: per-turn tool call limit guard.
 *
 * Provides a soft limit that can be opt-in via `maxToolCallsPerTurn` in
 * `SubscribeEmbeddedPiSessionParams`. When the count reaches the limit, a
 * structured warning is injected into the model-visible tool result, asking
 * it to stop calling tools and summarize or ask. No hard failure occurs.
 *
 * Default limit is 0 (disabled) — behavior is preserved for all existing
 * callers that do not set the param.
 */

/** Sentinel value: limit is disabled. Used as default. */
export const MAX_TOOL_CALLS_PER_TURN_DISABLED = 0;

/**
 * Conservative recommended limit for opt-in use.
 * Matches the doc guidance of ≤ 25 tool calls per turn before prompting
 * the model to pause and summarize.
 */
export const MAX_TOOL_CALLS_PER_TURN_CONSERVATIVE = 25;

/**
 * Returns true when the per-turn limit has been reached.
 * Returns false unconditionally when `limit` is 0 (disabled).
 */
export function isToolCallLimitExceeded(count: number, limit: number): boolean {
  return limit > 0 && count >= limit;
}

/**
 * Builds the model-visible warning text injected into the tool result when
 * the per-turn limit is exceeded.
 *
 * The text is designed to be clear to a language model: it names the limit,
 * the current count, and explicitly tells the model to stop, summarize, and
 * ask rather than continuing to call tools.
 *
 * Never throws.
 */
export function buildToolCallLimitWarning(params: {
  toolName: string;
  count: number;
  limit: number;
}): string {
  return (
    `[TOOL_LOOP_GUARD] Per-turn tool call limit reached: ${params.count} of ${params.limit} calls used this turn (last: ${params.toolName}).\n` +
    `You have called ${params.count} tools in this turn. Please stop calling additional tools, ` +
    `summarize what you have found so far, and either respond to the user or ask a clarifying question ` +
    `before continuing with more tool calls.`
  );
}
