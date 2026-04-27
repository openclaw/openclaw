import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";

export const CEREBRAS_MODEL_CATALOG = [
  {
    id: "zai-glm-4.7",
    name: "Z.ai GLM 4.7",
    reasoning: true,
    input: ["text"],
    cost: { input: 2.25, output: 2.75, cacheRead: 2.25, cacheWrite: 2.75 },
  },
  {
    id: "gpt-oss-120b",
    name: "GPT OSS 120B",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.35, output: 0.75, cacheRead: 0.35, cacheWrite: 0.75 },
  },
  {
    id: "qwen-3-235b-a22b-instruct-2507",
    name: "Qwen 3 235B Instruct",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.6, output: 1.2, cacheRead: 0.6, cacheWrite: 1.2 },
  },
  {
    id: "llama3.1-8b",
    name: "Llama 3.1 8B",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.1, output: 0.1, cacheRead: 0.1, cacheWrite: 0.1 },
  },
] as const;

export function buildCerebrasModelDefinition(
  model: (typeof CEREBRAS_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    api: "openai-completions",
    reasoning: model.reasoning,
    input: [...model.input],
    cost: model.cost,
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}
