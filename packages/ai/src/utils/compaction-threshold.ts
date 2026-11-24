/**
 * The one compaction trigger for every route, client and provider-side: 85% of
 * the window, capped by the window minus the separate summary/output reserve.
 * The remaining 15% leaves room for the warm summary request (appended
 * instruction plus summary output).
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
    Math.min(contextWindow - reserveTokens, Math.floor(contextWindow * 0.85)),
    Math.floor(params.minimumThresholdTokens ?? 0),
  );
}
