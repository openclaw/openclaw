import {
  applyProviderNativeStreamingUsageCompat,
  supportsNativeStreamingUsageCompat,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
export const MOONSHOT_CN_BASE_URL = "https://api.moonshot.cn/v1";
export const MOONSHOT_DEFAULT_MODEL_ID = "kimi-k2.5";
const MOONSHOT_DEFAULT_CONTEXT_WINDOW = 262144;
const MOONSHOT_DEFAULT_MAX_TOKENS = 262144;

// Per-model costs (USD per token). Sourced from Moonshot's public pricing
// pages at platform.kimi.ai/docs/pricing/chat-k25 and chat-k2 (retrieved
// 2026-04-17). `input` is the cache-miss rate (charged when a cached
// prefix does not exist), `cacheRead` is the cache-hit input rate, and
// `cacheWrite` is charged at the same rate as `input` (cache writes
// happen only on the first occurrence of a prefix, so pay the normal
// input price once, then cache reads at the lower rate thereafter).
// Moonshot's pricing is quoted per 1M tokens; divide by 1_000_000 to
// convert to the per-token shape Pi's provider catalog expects.
const MOONSHOT_K25_COST = {
  input: 0.6e-6,
  output: 3.0e-6,
  cacheRead: 0.1e-6,
  cacheWrite: 0.6e-6,
};

const MOONSHOT_K2_THINKING_COST = {
  input: 0.6e-6,
  output: 2.5e-6,
  cacheRead: 0.15e-6,
  cacheWrite: 0.6e-6,
};

const MOONSHOT_K2_TURBO_COST = {
  input: 1.15e-6,
  output: 8.0e-6,
  cacheRead: 0.15e-6,
  cacheWrite: 1.15e-6,
};

const MOONSHOT_MODEL_CATALOG = [
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    reasoning: false,
    input: ["text", "image"],
    cost: MOONSHOT_K25_COST,
    contextWindow: MOONSHOT_DEFAULT_CONTEXT_WINDOW,
    maxTokens: MOONSHOT_DEFAULT_MAX_TOKENS,
  },
  {
    id: "kimi-k2-thinking",
    name: "Kimi K2 Thinking",
    reasoning: true,
    input: ["text"],
    cost: MOONSHOT_K2_THINKING_COST,
    contextWindow: 262144,
    maxTokens: 262144,
  },
  {
    id: "kimi-k2-thinking-turbo",
    name: "Kimi K2 Thinking Turbo",
    reasoning: true,
    input: ["text"],
    cost: MOONSHOT_K2_TURBO_COST,
    contextWindow: 262144,
    maxTokens: 262144,
  },
  {
    id: "kimi-k2-turbo",
    name: "Kimi K2 Turbo",
    reasoning: false,
    input: ["text"],
    cost: MOONSHOT_K2_TURBO_COST,
    contextWindow: 256000,
    maxTokens: 16384,
  },
] as const;

export function isNativeMoonshotBaseUrl(baseUrl: string | undefined): boolean {
  return supportsNativeStreamingUsageCompat({
    providerId: "moonshot",
    baseUrl,
  });
}

export function applyMoonshotNativeStreamingUsageCompat(
  provider: ModelProviderConfig,
): ModelProviderConfig {
  return applyProviderNativeStreamingUsageCompat({
    providerId: "moonshot",
    providerConfig: provider,
  });
}

export function buildMoonshotProvider(): ModelProviderConfig {
  return {
    baseUrl: MOONSHOT_BASE_URL,
    api: "openai-completions",
    models: MOONSHOT_MODEL_CATALOG.map((model) => ({ ...model, input: [...model.input] })),
  };
}
