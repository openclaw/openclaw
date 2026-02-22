import type { ModelDefinitionConfig } from "../config/types.models.js";

export const FAL_OPENROUTER_BASE_URL = "https://fal.run/openrouter/router/openai/v1";

// Models listed in the fal OpenRouter playground dropdown.
export const FAL_OPENROUTER_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: { input: 0.15, output: 0.6, cacheRead: 0.0375, cacheWrite: 0.15 },
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 16384,
    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: "anthropic/claude-opus-4.6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 32000,
    cost: { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  },
  {
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 16384,
    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: "openai/gpt-4.1",
    name: "GPT-4.1",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 32768,
    cost: { input: 2.0, output: 8.0, cacheRead: 0.5, cacheWrite: 2.0 },
  },
  {
    id: "openai/gpt-oss-120b",
    name: "GPT OSS 120B",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 32768,
    cost: { input: 3.0, output: 12.0, cacheRead: 3.0, cacheWrite: 3.0 },
  },
  {
    id: "meta-llama/llama-4-maverick",
    name: "Llama 4 Maverick",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 32768,
    cost: { input: 0.2, output: 0.6, cacheRead: 0.2, cacheWrite: 0.2 },
  },
];

export function buildFalOpenrouterModelDefinition(
  model: (typeof FAL_OPENROUTER_MODEL_CATALOG)[number],
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
