export interface ModelRouterConfig {
  enabled: boolean;
  tiers: {
    cheap: { provider: string; modelId: string };
    mid: { provider: string; modelId: string };
    complex: { provider: string; modelId: string };
  };
  thresholds: { moderate: number; complex: number };
  toolContinuationTier: "cheap" | "mid" | "complex";
}

function parseTier(
  envValue: string | undefined,
  fallback: { provider: string; modelId: string },
): { provider: string; modelId: string } {
  if (!envValue) {
    return fallback;
  }
  const slashIndex = envValue.indexOf("/");
  if (slashIndex === -1) {
    return fallback;
  }
  const provider = envValue.slice(0, slashIndex).trim();
  const modelId = envValue.slice(slashIndex + 1).trim();
  if (!provider || !modelId) {
    return fallback;
  }
  return { provider, modelId };
}

/**
 * Load model router configuration from `OC_ROUTER_*` env vars.
 * Returns `null` when the router is disabled or not configured.
 */
export function loadModelRouterConfig(): ModelRouterConfig | null {
  if (process.env.OC_ROUTER_ENABLED !== "true") {
    return null;
  }

  const cheap = parseTier(process.env.OC_ROUTER_CHEAP, {
    provider: "anthropic",
    modelId: "claude-haiku-4-5",
  });
  const mid = parseTier(process.env.OC_ROUTER_MID, {
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
  });
  const complex = parseTier(process.env.OC_ROUTER_COMPLEX, {
    provider: "anthropic",
    modelId: "claude-opus-4-6",
  });

  const moderate = Number(process.env.OC_ROUTER_MODERATE_THRESHOLD) || 2;
  const complexThreshold = Number(process.env.OC_ROUTER_COMPLEXITY_THRESHOLD) || 4;

  const toolTierRaw = process.env.OC_ROUTER_TOOL_CONTINUATION ?? "cheap";
  const toolContinuationTier =
    toolTierRaw === "mid" || toolTierRaw === "complex" ? toolTierRaw : "cheap";

  return {
    enabled: true,
    tiers: { cheap, mid, complex },
    thresholds: { moderate, complex: complexThreshold },
    toolContinuationTier,
  };
}
