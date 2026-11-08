import type { Session, ViewEvent } from "@muse-code/sdk";
import { normalizeUsage } from "openclaw/plugin-sdk/agent-harness-runtime";

/** `turn/completed` is the only frame carrying a turn's aggregate token totals. */
export type MuseTurnUsage = NonNullable<
  Extract<ViewEvent, { method: "turn/completed" }>["params"]["usage"]
>;

/**
 * Project Muse's accounting onto the host usage contract.
 *
 * Two provider facts are deliberately not re-derived here, because MSP documents
 * both as convention-dependent:
 *
 * - `cachedTokens` sits inside or beside `inputTokens` depending on the provider,
 *   so it is never folded into `cacheRead` on its own. Only the explicit
 *   `cacheReadTokens` / `cacheWriteTokens` split is trusted, and it is removed from
 *   the reported input so the host does not double-count cache.
 * - `session/contextUsage.pressure` is the host's own basis over its own thresholds,
 *   so only the measured occupancy (`usedTokens`) is forwarded.
 *
 * Occupancy is read from the folded session state rather than the turn frame: MSP
 * emits `session/contextUsage` once per changed triple for the whole session, and
 * the turn's own `turn/completed` params carry no window figure.
 */
export function projectMuseAttemptUsage(
  turnUsage: MuseTurnUsage | undefined,
  session: Pick<Session, "fold"> | undefined,
): ReturnType<typeof normalizeUsage> {
  const context = session?.fold.sessionState.get("session/contextUsage") ?? undefined;
  const contextUsage =
    context && context.usedTokens > 0
      ? {
          state: "available" as const,
          promptTokens: context.usedTokens,
          totalTokens: context.usedTokens,
        }
      : undefined;
  if (!turnUsage) {
    return contextUsage ? normalizeUsage({ contextUsage }) : undefined;
  }
  const cacheRead = turnUsage.cacheReadTokens;
  const cacheWrite = turnUsage.cacheWriteTokens;
  // Only a reported split makes the input total inclusive of cache; without one the
  // bare input count is the only number the provider actually stated.
  const input =
    cacheRead === undefined && cacheWrite === undefined
      ? turnUsage.inputTokens
      : turnUsage.inputTokens - (cacheRead ?? 0) - (cacheWrite ?? 0);
  return normalizeUsage({
    ...(input >= 0 ? { input } : {}),
    output: turnUsage.outputTokens,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    reasoningTokens: turnUsage.reasoningTokens,
    total: turnUsage.inputTokens + turnUsage.outputTokens,
    ...(contextUsage ? { contextUsage } : {}),
  });
}
