import type { PromptTier, SmartRouterConfig, TierModelMapping } from "./types.js";

/**
 * Look up the user's configured model for the given tier.
 * Returns `null` when no mapping is configured — the caller should
 * skip overriding so the default model resolution takes over.
 */
export function resolveModelForTier(
  tier: PromptTier,
  config: SmartRouterConfig,
): TierModelMapping | null {
  const mapping = config.tiers?.[tier];
  if (!mapping?.provider || !mapping?.model) return null;
  return { provider: mapping.provider, model: mapping.model };
}
