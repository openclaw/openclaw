import type { ModelDefinitionConfig, ModelProviderConfig } from "openclaw/plugin-sdk/provider-models";

export const AISA_BASE_URL = "https://api.aisa.one/v1";
export const AISA_DEFAULT_MODEL_ID = "kimi-k2.5";
export const AISA_DEFAULT_CONTEXT_WINDOW = 256000;
export const AISA_DEFAULT_MAX_TOKENS = 32768;

const AISA_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "minimax-m2.1",
    name: "MiniMax M2.1",
    reasoning: false,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: AISA_DEFAULT_MAX_TOKENS,
    cost: { input: 0.21, output: 0.84 },
  },
  {
    id: "seed-1-8-251228",
    name: "Seed 1.8",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: AISA_DEFAULT_MAX_TOKENS,
    cost: { input: 0.225, output: 1.8 },
  },
  {
    id: "deepseek-v3.2",
    name: "DeepSeek V3.2",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: AISA_DEFAULT_MAX_TOKENS,
    cost: { input: 0.28, output: 0.42 },
  },
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text"],
    contextWindow: AISA_DEFAULT_CONTEXT_WINDOW,
    maxTokens: AISA_DEFAULT_MAX_TOKENS,
    cost: { input: 0.4, output: 2.11 },
  },
  {
    id: "qwen3-max",
    name: "Qwen3 Max",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: AISA_DEFAULT_CONTEXT_WINDOW,
    maxTokens: AISA_DEFAULT_MAX_TOKENS,
    cost: { input: 0.72, output: 3.6 },
  },
  {
    id: "glm-5",
    name: "GLM-5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: AISA_DEFAULT_MAX_TOKENS,
    cost: { input: 1.0, output: 3.2 },
  },
];

export function buildAisaProvider(): ModelProviderConfig {
  return {
    baseUrl: AISA_BASE_URL,
    api: "openai-completions",
    models: AISA_MODEL_CATALOG,
  };
}
