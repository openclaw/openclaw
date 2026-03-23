import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-models";

const OFOXAI_BASE_URL = "https://api.ofox.ai/v1";
const OFOXAI_DEFAULT_CONTEXT_WINDOW = 128000;
const OFOXAI_DEFAULT_MAX_TOKENS = 8192;
const OFOXAI_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function buildOfoxaiProvider(): ModelProviderConfig {
  return {
    baseUrl: OFOXAI_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        reasoning: false,
        input: ["text", "image"],
        cost: OFOXAI_DEFAULT_COST,
        contextWindow: OFOXAI_DEFAULT_CONTEXT_WINDOW,
        maxTokens: OFOXAI_DEFAULT_MAX_TOKENS,
      },
      {
        id: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        reasoning: false,
        input: ["text", "image"],
        cost: OFOXAI_DEFAULT_COST,
        contextWindow: 200000,
        maxTokens: OFOXAI_DEFAULT_MAX_TOKENS,
      },
      {
        id: "deepseek-chat",
        name: "DeepSeek V3",
        reasoning: false,
        input: ["text"],
        cost: OFOXAI_DEFAULT_COST,
        contextWindow: 64000,
        maxTokens: OFOXAI_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}
