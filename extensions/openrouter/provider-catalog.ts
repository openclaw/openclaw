import type { ModelProviderConfig, ProviderRuntimeModel } from "openclaw/plugin-sdk/provider-model-shared";
import {
  ensureOpenRouterModelCache,
  getOpenRouterModelCapabilities,
} from "openclaw/plugin-sdk/provider-stream-family";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_DEFAULT_MODEL_ID = "auto";
const OPENROUTER_DEFAULT_CONTEXT_WINDOW = 200000;
const OPENROUTER_DEFAULT_MAX_TOKENS = 8192;
const OPENROUTER_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

interface OpenRouterModelEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

/**
 * Convert cached OpenRouter model capabilities to provider model entries.
 * Falls back to defaults if cache is not populated yet.
 */
function getOpenRouterCatalogModels(): OpenRouterModelEntry[] {
  // Ensure cache is loaded (from disk or memory)
  ensureOpenRouterModelCache();

  // Try to get all models from the cache by checking common model IDs
  // The cache is populated from https://openrouter.ai/api/v1/models
  const popularModelIds = [
    "openai/gpt-5.4",
    "openai/gpt-5.4-mini",
    "openai/gpt-5.4-nano",
    "anthropic/claude-3.7-sonnet",
    "anthropic/claude-3.7-sonnet:thinking",
    "anthropic/claude-3.5-sonnet",
    "google/gemini-2.5-pro-preview-03-25",
    "google/gemini-2.0-flash-001",
    "deepseek/deepseek-chat-v3-0324",
    "deepseek/deepseek-r1",
    "x-ai/grok-3-beta",
    "x-ai/grok-3-mini-beta",
    "meta-llama/llama-4-maverick",
    "meta-llama/llama-4-scout",
    "qwen/qwen3-235b-a22b",
    "mistralai/mistral-large-2411",
    "cohere/command-a",
    "perplexity/sonar-pro",
    "openrouter/optimus-alpha",
    "openrouter/hunter-alpha",
    "openrouter/healer-alpha",
  ];

  const models: OpenRouterModelEntry[] = [
    // Always include the default "auto" model
    {
      id: OPENROUTER_DEFAULT_MODEL_ID,
      name: "OpenRouter Auto",
      reasoning: false,
      input: ["text", "image"],
      cost: OPENROUTER_DEFAULT_COST,
      contextWindow: OPENROUTER_DEFAULT_CONTEXT_WINDOW,
      maxTokens: OPENROUTER_DEFAULT_MAX_TOKENS,
    },
  ];

  // Add models from cache if available
  for (const modelId of popularModelIds) {
    const caps = getOpenRouterModelCapabilities(modelId);
    if (caps) {
      models.push({
        id: modelId,
        name: caps.name,
        reasoning: caps.reasoning,
        input: caps.input,
        cost: caps.cost,
        contextWindow: caps.contextWindow,
        maxTokens: caps.maxTokens,
      });
    }
  }

  return models;
}

export function buildOpenrouterProvider(): ModelProviderConfig {
  return {
    baseUrl: OPENROUTER_BASE_URL,
    api: "openai-completions",
    models: getOpenRouterCatalogModels(),
  };
}

/**
 * Build a runtime model definition for any OpenRouter model ID.
 * This enables using any model available on OpenRouter, not just the cached popular ones.
 */
export function buildDynamicOpenRouterModel(modelId: string): ProviderRuntimeModel {
  const caps = getOpenRouterModelCapabilities(modelId);

  return {
    id: modelId,
    name: caps?.name ?? modelId,
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: OPENROUTER_BASE_URL,
    reasoning: caps?.reasoning ?? false,
    input: caps?.input ?? ["text"],
    cost: caps?.cost ?? OPENROUTER_DEFAULT_COST,
    contextWindow: caps?.contextWindow ?? OPENROUTER_DEFAULT_CONTEXT_WINDOW,
    maxTokens: caps?.maxTokens ?? OPENROUTER_DEFAULT_MAX_TOKENS,
  };
}
