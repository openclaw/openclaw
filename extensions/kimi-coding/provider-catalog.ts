import {
  KIMI_MODEL_CATALOG,
  type ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-models";

export const KIMI_BASE_URL = "https://api.kimi.com/coding/";
const KIMI_CODING_USER_AGENT = "claude-code/0.1.0";
export const KIMI_DEFAULT_MODEL_ID = "kimi-code";
export const KIMI_UPSTREAM_MODEL_ID = "kimi-for-coding";
export const KIMI_LEGACY_MODEL_ID = "k2p5";
const KIMI_CODING_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function buildKimiCodingProvider(): ModelProviderConfig {
  return {
    baseUrl: KIMI_BASE_URL,
    api: "anthropic-messages",
    headers: {
      "User-Agent": KIMI_CODING_USER_AGENT,
    },
    models: KIMI_MODEL_CATALOG.map((entry) => ({
      id: entry.id,
      name: entry.name,
      reasoning: entry.reasoning,
      input: [...entry.input],
      cost: KIMI_CODING_DEFAULT_COST,
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
    })),
  };
}

export const KIMI_CODING_BASE_URL = KIMI_BASE_URL;
export const KIMI_CODING_DEFAULT_MODEL_ID = KIMI_DEFAULT_MODEL_ID;
export const KIMI_CODING_LEGACY_MODEL_ID = KIMI_LEGACY_MODEL_ID;
export const buildKimiProvider = buildKimiCodingProvider;
