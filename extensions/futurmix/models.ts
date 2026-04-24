import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const FUTURMIX_BASE_URL = "https://futurmix.ai/v1";

export const FUTURMIX_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4-7",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 32000,
    cost: {
      input: 5.0,
      output: 25.0,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    },
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4-6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 32000,
    cost: {
      input: 5.0,
      output: 25.0,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    },
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4-6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    cost: {
      input: 3.0,
      output: 15.0,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    },
  },
  {
    id: "claude-sonnet-4-5-20250929",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    cost: {
      input: 3.0,
      output: 15.0,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    },
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: {
      input: 1.0,
      output: 5.0,
      cacheRead: 0.08,
      cacheWrite: 1.25,
    },
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: {
      input: 1.25,
      output: 10.0,
      cacheRead: 0.31,
      cacheWrite: 1.25,
    },
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: {
      input: 0.15,
      output: 0.60,
      cacheRead: 0.0375,
      cacheWrite: 0.15,
    },
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: {
      input: 2.50,
      output: 10.0,
      cacheRead: 1.25,
      cacheWrite: 2.50,
    },
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: {
      input: 0.40,
      output: 1.60,
      cacheRead: 0.10,
      cacheWrite: 0.40,
    },
  },
];

export function buildFuturMixModelDefinition(
  model: (typeof FUTURMIX_MODEL_CATALOG)[number],
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
