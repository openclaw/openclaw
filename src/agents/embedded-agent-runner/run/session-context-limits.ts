/** Attempts and recovery must hydrate the same bounded model-context view. */
export function resolveEmbeddedSessionContextLimits(contextTokenBudget?: number) {
  return {
    maxBytes: Math.min(64 * 1024 * 1024, Math.max(1024, (contextTokenBudget ?? 128_000) * 8)),
    maxEvents: 10_000,
  };
}
