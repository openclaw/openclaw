/**
 * Pricing database for major AI model providers.
 *
 * Prices are in USD per 1 million tokens unless otherwise noted.
 * Cache read/write prices are also per 1M tokens where applicable.
 *
 * Sources: Official provider pricing pages as of 2026-03.
 * This is a best-effort static snapshot — providers change pricing frequently.
 */

export type ModelPricing = {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
  /** USD per 1M cache-read tokens (if supported) */
  cacheRead?: number;
  /** USD per 1M cache-write tokens (if supported) */
  cacheWrite?: number;
};

export type ProviderPricingEntry = {
  provider: string;
  /** Model ID pattern — supports exact match or glob-like prefix (e.g. "gpt-5*") */
  pattern: string;
  pricing: ModelPricing;
};

/**
 * Static pricing table. Models are matched in order; first match wins.
 * Use prefix patterns (ending with `*`) for model families.
 */
const PRICING_TABLE: ProviderPricingEntry[] = [
  // ── Anthropic ──────────────────────────────────────────────────────────
  {
    provider: "anthropic",
    pattern: "claude-opus-4*",
    pricing: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  },
  {
    provider: "anthropic",
    pattern: "claude-sonnet-4*",
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    provider: "anthropic",
    pattern: "claude-3-5-haiku*",
    pricing: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  },
  {
    provider: "anthropic",
    pattern: "claude-3-haiku*",
    pricing: { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 },
  },

  // ── OpenAI ─────────────────────────────────────────────────────────────
  {
    provider: "openai",
    pattern: "gpt-5*",
    pricing: { input: 10, output: 30, cacheRead: 2.5 },
  },
  {
    provider: "openai",
    pattern: "gpt-4.1-nano*",
    pricing: { input: 0.1, output: 0.4, cacheRead: 0.025 },
  },
  {
    provider: "openai",
    pattern: "gpt-4.1-mini*",
    pricing: { input: 0.4, output: 1.6, cacheRead: 0.1 },
  },
  {
    provider: "openai",
    pattern: "gpt-4.1*",
    pricing: { input: 2, output: 8, cacheRead: 0.5 },
  },
  {
    provider: "openai",
    pattern: "o4-mini*",
    pricing: { input: 1.1, output: 4.4, cacheRead: 0.275 },
  },
  {
    provider: "openai",
    pattern: "o3*",
    pricing: { input: 10, output: 40, cacheRead: 2.5 },
  },

  // ── Google ─────────────────────────────────────────────────────────────
  {
    provider: "google",
    pattern: "gemini-2.5-pro*",
    pricing: { input: 1.25, output: 10 },
  },
  {
    provider: "google",
    pattern: "gemini-2.5-flash*",
    pricing: { input: 0.15, output: 0.6 },
  },
  {
    provider: "google",
    pattern: "gemini-2.0-flash*",
    pricing: { input: 0.1, output: 0.4 },
  },

  // ── DeepSeek ───────────────────────────────────────────────────────────
  {
    provider: "deepseek",
    pattern: "deepseek-chat*",
    pricing: { input: 0.27, output: 1.1, cacheRead: 0.07 },
  },
  {
    provider: "deepseek",
    pattern: "deepseek-reasoner*",
    pricing: { input: 0.55, output: 2.19, cacheRead: 0.14 },
  },

  // ── Mistral ────────────────────────────────────────────────────────────
  {
    provider: "mistral",
    pattern: "mistral-large*",
    pricing: { input: 2, output: 6 },
  },
  {
    provider: "mistral",
    pattern: "mistral-small*",
    pricing: { input: 0.1, output: 0.3 },
  },
  {
    provider: "mistral",
    pattern: "codestral*",
    pricing: { input: 0.3, output: 0.9 },
  },

  // ── Groq ───────────────────────────────────────────────────────────────
  {
    provider: "groq",
    pattern: "llama-*-70b*",
    pricing: { input: 0.59, output: 0.79 },
  },
  {
    provider: "groq",
    pattern: "llama-*-8b*",
    pricing: { input: 0.05, output: 0.08 },
  },
  {
    provider: "groq",
    pattern: "mixtral*",
    pricing: { input: 0.24, output: 0.24 },
  },

  // ── xAI ────────────────────────────────────────────────────────────────
  {
    provider: "xai",
    pattern: "grok-3-mini*",
    pricing: { input: 0.3, output: 0.5 },
  },
  {
    provider: "xai",
    pattern: "grok-3*",
    pricing: { input: 3, output: 15 },
  },

  // ── Together ───────────────────────────────────────────────────────────
  {
    provider: "together",
    pattern: "meta-llama/Meta-Llama-3*-70B*",
    pricing: { input: 0.88, output: 0.88 },
  },
  {
    provider: "together",
    pattern: "meta-llama/Meta-Llama-3*-8B*",
    pricing: { input: 0.18, output: 0.18 },
  },

  // ── Perplexity ─────────────────────────────────────────────────────────
  {
    provider: "perplexity",
    pattern: "sonar-pro*",
    pricing: { input: 3, output: 15 },
  },
  {
    provider: "perplexity",
    pattern: "sonar*",
    pricing: { input: 1, output: 1 },
  },
];

/**
 * Match a model ID against a pattern.
 * Supports exact match and prefix glob (pattern ending with `*`).
 */
function matchesPattern(modelId: string, pattern: string): boolean {
  const normalizedModel = modelId.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();

  if (normalizedPattern.endsWith("*")) {
    const prefix = normalizedPattern.slice(0, -1);
    return normalizedModel.startsWith(prefix);
  }
  return normalizedModel === normalizedPattern;
}

/**
 * Look up pricing for a provider/model combination.
 * Returns undefined if no pricing data is available.
 */
export function lookupPricing(provider: string, modelId: string): ModelPricing | undefined {
  const normalizedProvider = provider.toLowerCase().trim();

  for (const entry of PRICING_TABLE) {
    if (entry.provider !== normalizedProvider) {
      continue;
    }
    if (matchesPattern(modelId, entry.pattern)) {
      return entry.pricing;
    }
  }

  return undefined;
}

/**
 * Calculate the cost for a specific usage event.
 */
export function calculateCost(params: {
  pricing: ModelPricing;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  totalCost: number;
} {
  const { pricing, inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0 } = params;

  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * (pricing.cacheRead ?? pricing.input);
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * (pricing.cacheWrite ?? pricing.input);

  return {
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    totalCost: inputCost + outputCost + cacheReadCost + cacheWriteCost,
  };
}

/**
 * Get all known providers in the pricing database.
 */
export function getKnownProviders(): string[] {
  return [...new Set(PRICING_TABLE.map((e) => e.provider))];
}

/**
 * Get all pricing entries for a specific provider.
 */
export function getProviderPricing(provider: string): ProviderPricingEntry[] {
  const normalized = provider.toLowerCase().trim();
  return PRICING_TABLE.filter((e) => e.provider === normalized);
}
