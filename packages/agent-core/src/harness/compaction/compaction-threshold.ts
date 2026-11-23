/**
 * The one compaction trigger for every route: 80% of the window, capped by the
 * window minus the separate summary/output reserve. The remaining 20% leaves room
 * for the warm summary request (appended instruction plus summary output).
 */
export function resolveCompactionThreshold(params: {
  contextWindowTokens: number;
  reserveTokensFloor: number;
  minimumThresholdTokens?: number;
}): number {
  const contextWindow = Math.max(1, Math.floor(params.contextWindowTokens));
  const reserveTokens = Math.max(0, Math.floor(params.reserveTokensFloor));
  return Math.max(
    0,
    Math.min(contextWindow - reserveTokens, Math.floor(contextWindow * 0.8)),
    Math.floor(params.minimumThresholdTokens ?? 0),
  );
}
