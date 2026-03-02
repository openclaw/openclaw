import type { ModelDefinitionConfig } from "../config/types.models.js";

const AZURE_FOUNDRY_ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const AZURE_FOUNDRY_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "gpt-4o",
    name: "GPT-4o",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: AZURE_FOUNDRY_ZERO_COST,
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: AZURE_FOUNDRY_ZERO_COST,
  },
  {
    id: "gpt-4.1",
    name: "GPT-4.1",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 1047576,
    maxTokens: 32768,
    cost: AZURE_FOUNDRY_ZERO_COST,
  },
  {
    id: "gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 1047576,
    maxTokens: 32768,
    cost: AZURE_FOUNDRY_ZERO_COST,
  },
  {
    id: "gpt-4.1-nano",
    name: "GPT-4.1 Nano",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 1047576,
    maxTokens: 32768,
    cost: AZURE_FOUNDRY_ZERO_COST,
  },
  {
    id: "o3-mini",
    name: "o3-mini",
    reasoning: true,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 100000,
    cost: AZURE_FOUNDRY_ZERO_COST,
  },
  {
    id: "o4-mini",
    name: "o4-mini",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 100000,
    cost: AZURE_FOUNDRY_ZERO_COST,
  },
  {
    id: "DeepSeek-R1",
    name: "DeepSeek R1",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: AZURE_FOUNDRY_ZERO_COST,
  },
  {
    id: "Phi-4",
    name: "Phi-4",
    reasoning: false,
    input: ["text"],
    contextWindow: 16384,
    maxTokens: 4096,
    cost: AZURE_FOUNDRY_ZERO_COST,
  },
  {
    id: "Mistral-large-2411",
    name: "Mistral Large 2411",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: AZURE_FOUNDRY_ZERO_COST,
  },
  {
    id: "Meta-Llama-3.1-405B-Instruct",
    name: "Meta Llama 3.1 405B Instruct",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: AZURE_FOUNDRY_ZERO_COST,
  },
  {
    id: "Cohere-command-r-plus-08-2024",
    name: "Cohere Command R+ (08-2024)",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 4096,
    cost: AZURE_FOUNDRY_ZERO_COST,
  },
];

// Anthropic (Claude) models available on Azure AI Foundry.
// These use the /anthropic endpoint and the anthropic-messages API.
export const AZURE_FOUNDRY_ANTHROPIC_MODELS: Omit<
  ModelDefinitionConfig,
  "api" | "baseUrl" | "headers"
>[] = [
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 16384,
    cost: AZURE_FOUNDRY_ZERO_COST,
  },
  {
    id: "claude-sonnet-4-5-20250514",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 16384,
    cost: AZURE_FOUNDRY_ZERO_COST,
  },
  {
    id: "claude-haiku-3-5-20241022",
    name: "Claude Haiku 3.5",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: AZURE_FOUNDRY_ZERO_COST,
  },
];

export const AZURE_FOUNDRY_ANTHROPIC_API_VERSION = "2023-06-01";

export function buildAzureFoundryModelDefinition(
  model: (typeof AZURE_FOUNDRY_MODEL_CATALOG)[number],
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

export function buildAzureFoundryAnthropicModelDefinition(
  model: (typeof AZURE_FOUNDRY_ANTHROPIC_MODELS)[number],
  anthropicBaseUrl: string,
): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    api: "anthropic-messages",
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    baseUrl: anthropicBaseUrl,
    headers: { "api-version": AZURE_FOUNDRY_ANTHROPIC_API_VERSION },
  };
}

export function isAnthropicModelId(modelId: string): boolean {
  return modelId.toLowerCase().startsWith("claude");
}
