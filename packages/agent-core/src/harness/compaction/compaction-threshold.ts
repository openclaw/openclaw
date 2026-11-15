/** Trigger early without expanding the separate summary/output reserve. */
export function resolveCompactionThreshold(params: {
  contextWindowTokens: number;
  reserveTokensFloor: number;
  minimumThresholdTokens?: number;
}): number {
  const contextWindow = Math.max(1, Math.floor(params.contextWindowTokens));
  const reserveTokens = Math.max(0, Math.floor(params.reserveTokensFloor));
  return Math.max(
    0,
    Math.min(contextWindow - reserveTokens, Math.floor(contextWindow * 0.75)),
    Math.floor(params.minimumThresholdTokens ?? 0),
  );
}
