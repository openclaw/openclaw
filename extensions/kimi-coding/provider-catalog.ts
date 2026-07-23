// Kimi Coding provider module implements model/runtime integration.
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

const KIMI_BASE_URL = "https://api.kimi.com/coding/";
const KIMI_CODING_USER_AGENT = "claude-code/0.1.0";
const KIMI_DEFAULT_MODEL_ID = "kimi-for-coding";
const KIMI_HIGHSPEED_MODEL_ID = "kimi-for-coding-highspeed";
// k3[1m] is a Claude-Code-only env-var convention, not a valid API model id.
// Normalize it to k3 for wire requests; context entitlement is account-tier-gated.
const KIMI_LEGACY_MODEL_IDS = ["kimi-code", "k2p5", "k3[1m]"] as const;
const KIMI_K3_CONTEXT_WINDOW = 1_048_576;
const KIMI_CODING_DEFAULT_CONTEXT_WINDOW = 262144;
const KIMI_CODING_DEFAULT_MAX_TOKENS = 32768;
const KIMI_CODING_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
const KIMI_CODING_INPUT = ["text", "image"] satisfies NonNullable<ModelDefinitionConfig["input"]>;

export function buildKimiCodingProvider(): ModelProviderConfig {
  return {
    baseUrl: KIMI_BASE_URL,
    api: "anthropic-messages",
    headers: {
      "User-Agent": KIMI_CODING_USER_AGENT,
    },
    models: [
      {
        id: KIMI_DEFAULT_MODEL_ID,
        name: "Kimi Code",
        reasoning: true,
        input: [...KIMI_CODING_INPUT],
        cost: KIMI_CODING_DEFAULT_COST,
        contextWindow: KIMI_CODING_DEFAULT_CONTEXT_WINDOW,
        maxTokens: KIMI_CODING_DEFAULT_MAX_TOKENS,
      },
      {
        id: KIMI_HIGHSPEED_MODEL_ID,
        name: "Kimi K2.7 Code HighSpeed",
        reasoning: true,
        input: [...KIMI_CODING_INPUT],
        cost: KIMI_CODING_DEFAULT_COST,
        contextWindow: KIMI_CODING_DEFAULT_CONTEXT_WINDOW,
        maxTokens: KIMI_CODING_DEFAULT_MAX_TOKENS,
      },
      {
        id: "k3",
        name: "Kimi K3",
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: null,
          medium: null,
          high: null,
          xhigh: "max" as const,
          max: "max" as const,
        },
        input: [...KIMI_CODING_INPUT],
        cost: KIMI_CODING_DEFAULT_COST,
        // Context window depends on account tier (256K Moderato, 1M Allegretto+).
        // Advertise the maximum to avoid rejecting valid requests from 1M accounts.
        contextWindow: KIMI_K3_CONTEXT_WINDOW,
        maxTokens: KIMI_CODING_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}

export function normalizeKimiCodingModelId(modelId: string): string {
  if (KIMI_LEGACY_MODEL_IDS.includes(modelId as (typeof KIMI_LEGACY_MODEL_IDS)[number])) {
    // kimi-code and k2p5 normalize to the default; k3[1m] normalizes to k3
    return modelId === "k3[1m]" ? "k3" : KIMI_DEFAULT_MODEL_ID;
  }
  return modelId;
}

export const KIMI_CODING_BASE_URL = KIMI_BASE_URL;
export const KIMI_CODING_DEFAULT_MODEL_ID = KIMI_DEFAULT_MODEL_ID;
export const KIMI_CODING_LEGACY_MODEL_IDS = KIMI_LEGACY_MODEL_IDS;
