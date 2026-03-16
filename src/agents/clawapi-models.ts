import type { ModelDefinitionConfig } from "../config/types.models.js";

export const CLAWAPI_BASE_URL = "https://clawapi.org/api/v1";

export const CLAWAPI_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6 (CEO)",
    reasoning: true,
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 4096,
    cost: {
      input: 5.0,
      output: 25.0,
      cacheRead: 5.0,
      cacheWrite: 25.0,
    },
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4 (CTO)",
    reasoning: true,
    input: ["text"],
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    cost: {
      input: 2.5,
      output: 15.0,
      cacheRead: 2.5,
      cacheWrite: 15.0,
    },
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (CMO)",
    reasoning: true,
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 4096,
    cost: {
      input: 3.0,
      output: 15.0,
      cacheRead: 3.0,
      cacheWrite: 15.0,
    },
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro (Researcher)",
    reasoning: true,
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 16_384,
    cost: {
      input: 2.0,
      output: 12.0,
      cacheRead: 2.0,
      cacheWrite: 12.0,
    },
  },
  {
    id: "gpt-5-mini",
    name: "GPT-5 Mini (CFO)",
    reasoning: true,
    input: ["text"],
    contextWindow: 400_000,
    maxTokens: 128_000,
    cost: {
      input: 0.25,
      output: 2.0,
      cacheRead: 0.25,
      cacheWrite: 2.0,
    },
  },
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash-Lite (Secretary)",
    reasoning: false,
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 32_768,
    cost: {
      input: 0.25,
      output: 1.5,
      cacheRead: 0.25,
      cacheWrite: 1.5,
    },
  },
  {
    id: "gpt-oss-120b",
    name: "GPT-OSS-120B (Engineer)",
    reasoning: false,
    input: ["text"],
    contextWindow: 131_072,
    maxTokens: 8192,
    cost: {
      input: 0.05,
      output: 0.45,
      cacheRead: 0.05,
      cacheWrite: 0.45,
    },
  },
  {
    id: "gpt-oss-20b",
    name: "GPT-OSS-20B (Intern)",
    reasoning: false,
    input: ["text"],
    contextWindow: 131_072,
    maxTokens: 8192,
    cost: {
      input: 0.04,
      output: 0.18,
      cacheRead: 0.04,
      cacheWrite: 0.18,
    },
  },
];

export function buildClawApiModelDefinition(
  model: (typeof CLAWAPI_MODEL_CATALOG)[number],
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
    compat: { supportsStore: false },
  };
}
