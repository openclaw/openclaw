export const MODEL_CONTEXT_TOKEN_CACHE = new Map<string, number>();

export function lookupCachedContextTokens(modelId?: string): number | undefined {
  if (!modelId) {
    return undefined;
  }
  return MODEL_CONTEXT_TOKEN_CACHE.get(modelId);
}
