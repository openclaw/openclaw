import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-models";

export const AVIAN_BASE_URL = "https://api.avian.io/v1";
export const AVIAN_DEFAULT_MODEL_ID = "deepseek/deepseek-v3.2";

const AVIAN_DEFAULT_CONTEXT_WINDOW = 164000;
const AVIAN_DEFAULT_MAX_TOKENS = 65536;
const AVIAN_DEFAULT_COST = {
  input: 0.26,
  output: 0.38,
  cacheRead: 0,
  cacheWrite: 0,
};

export function buildAvianProvider(): ModelProviderConfig {
  return {
    baseUrl: AVIAN_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: AVIAN_DEFAULT_MODEL_ID,
        name: "DeepSeek V3.2",
        reasoning: false,
        input: ["text"],
        cost: AVIAN_DEFAULT_COST,
        contextWindow: AVIAN_DEFAULT_CONTEXT_WINDOW,
        maxTokens: AVIAN_DEFAULT_MAX_TOKENS,
      },
      {
        id: "moonshotai/kimi-k2.5",
        name: "Kimi K2.5",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.45, output: 2.2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131000,
        maxTokens: 8192,
      },
      {
        id: "z-ai/glm-5",
        name: "GLM 5",
        reasoning: false,
        input: ["text"],
        cost: { input: 0.3, output: 2.55, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131000,
        maxTokens: 16384,
      },
      {
        id: "minimax/minimax-m2.5",
        name: "MiniMax M2.5",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.3, output: 1.1, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 1000000,
      },
    ],
  };
}
