import type { ModelDefinitionConfig } from "../config/types.models.js";

export const SAMBANOVA_BASE_URL = "https://api.sambanova.ai/v1";

export const SAMBANOVA_MODEL_CATALOG: ModelDefinitionConfig[] = [
  // DeepSeek family
  {
    id: "DeepSeek-R1-0528",
    name: "DeepSeek R1 0528",
    reasoning: true,
    input: ["text"],
    cost: { input: 5.0, output: 7.0, cacheRead: 5.0, cacheWrite: 5.0 },
    contextWindow: 131072,
    maxTokens: 16384,
  },
  {
    id: "DeepSeek-V3-0324",
    name: "DeepSeek V3 0324",
    reasoning: false,
    input: ["text"],
    cost: { input: 3.0, output: 4.5, cacheRead: 3.0, cacheWrite: 3.0 },
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "DeepSeek-V3.1",
    name: "DeepSeek V3.1",
    reasoning: true,
    input: ["text"],
    cost: { input: 3.0, output: 4.5, cacheRead: 3.0, cacheWrite: 3.0 },
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "DeepSeek-V3.1-cb",
    name: "DeepSeek V3.1 CB",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.15, output: 0.75, cacheRead: 0.15, cacheWrite: 0.15 },
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "DeepSeek-V3.1-Terminus",
    name: "DeepSeek V3.1 Terminus",
    reasoning: true,
    input: ["text"],
    cost: { input: 3.0, output: 4.5, cacheRead: 3.0, cacheWrite: 3.0 },
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "DeepSeek-V3.2",
    name: "DeepSeek V3.2",
    reasoning: true,
    input: ["text"],
    cost: { input: 3.0, output: 4.5, cacheRead: 3.0, cacheWrite: 3.0 },
    contextWindow: 131072,
    maxTokens: 8192,
  },
  // Meta Llama family
  {
    id: "Llama-3.3-Swallow-70B-Instruct-v0.4",
    name: "Llama 3.3 Swallow 70B",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.6, output: 1.2, cacheRead: 0.6, cacheWrite: 0.6 },
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "Llama-4-Maverick-17B-128E-Instruct",
    name: "Llama 4 Maverick 17B",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.63, output: 1.8, cacheRead: 0.63, cacheWrite: 0.63 },
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "Meta-Llama-3.1-8B-Instruct",
    name: "Llama 3.1 8B",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.1, output: 0.2, cacheRead: 0.1, cacheWrite: 0.1 },
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: "Meta-Llama-3.3-70B-Instruct",
    name: "Llama 3.3 70B",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.6, output: 1.2, cacheRead: 0.6, cacheWrite: 0.6 },
    contextWindow: 131072,
    maxTokens: 8192,
  },
  // MiniMax family
  {
    id: "MiniMax-M2.5",
    name: "MiniMax M2.5",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.3, output: 1.2, cacheRead: 0.3, cacheWrite: 0.3 },
    contextWindow: 131072,
    maxTokens: 8192,
  },
  // Qwen family
  {
    id: "Qwen3-235B",
    name: "Qwen3 235B",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.4, output: 0.8, cacheRead: 0.4, cacheWrite: 0.4 },
    contextWindow: 40960,
    maxTokens: 8192,
  },
  {
    id: "Qwen3-32B",
    name: "Qwen3 32B",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.4, output: 0.8, cacheRead: 0.4, cacheWrite: 0.4 },
    contextWindow: 40960,
    maxTokens: 8192,
  },
  // GPT family
  {
    id: "gpt-oss-120b",
    name: "GPT OSS 120B",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.22, output: 0.59, cacheRead: 0.22, cacheWrite: 0.22 },
    contextWindow: 131072,
    maxTokens: 8192,
  },
];

export function buildSambanovaModelDefinition(
  model: (typeof SAMBANOVA_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    api: "openai-completions",
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}
