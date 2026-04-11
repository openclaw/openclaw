import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { SERVEPATH_BASE_URL, SERVEPATH_DEFAULT_MODEL_ID } from "./defaults.js";

const SERVEPATH_DEFAULT_CONTEXT_WINDOW = 200000;
const SERVEPATH_DEFAULT_MAX_TOKENS = 8192;
const SERVEPATH_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function buildServepathProvider(): ModelProviderConfig {
  return {
    baseUrl: SERVEPATH_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: SERVEPATH_DEFAULT_MODEL_ID,
        name: "Servepath Router (alias: servepath)",
        reasoning: false,
        // Servepath's default route can accept richer requests and pick a
        // compatible downstream model at runtime.
        input: ["text", "image"],
        cost: SERVEPATH_DEFAULT_COST,
        contextWindow: SERVEPATH_DEFAULT_CONTEXT_WINDOW,
        maxTokens: SERVEPATH_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}

export function buildServepathDynamicModel(modelId: string) {
  return {
    id: modelId,
    name:
      modelId === SERVEPATH_DEFAULT_MODEL_ID
        ? "Servepath Router (alias: servepath)"
        : `Servepath ${modelId}`,
    provider: "servepath",
    api: "openai-completions" as const,
    baseUrl: SERVEPATH_BASE_URL,
    reasoning: false,
    input: ["text"] as const,
    cost: SERVEPATH_DEFAULT_COST,
    contextWindow: SERVEPATH_DEFAULT_CONTEXT_WINDOW,
    maxTokens: SERVEPATH_DEFAULT_MAX_TOKENS,
  };
}
