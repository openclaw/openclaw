// Llmrouter plugin module implements models behavior.
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  DEFAULT_CONTEXT_TOKENS,
  type ModelDefinitionConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const LLMROUTER_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "llmrouter",
  catalog: manifest.modelCatalog.providers.llmrouter,
});

export const LLMROUTER_BASE_URL = LLMROUTER_MANIFEST_PROVIDER.baseUrl;

export const LLMROUTER_MODEL_CATALOG: ModelDefinitionConfig[] = LLMROUTER_MANIFEST_PROVIDER.models;

export const LLMROUTER_DEFAULT_MODEL_ID = "auto";
export const LLMROUTER_DEFAULT_MODEL_REF = `llmrouter/${LLMROUTER_DEFAULT_MODEL_ID}`;

const LLMROUTER_DYNAMIC_MODEL_MAX_TOKENS = 8192;

/**
 * LLMRouter's `GET /v1/models` lists 500+ slugs (openai/*, anthropic/*, ...) that
 * change as its registry syncs — any id other than "auto" pins one of them directly
 * (DESIGN.md: "a slug pins"). Resolve it with generic capability defaults instead of
 * requiring a static catalog row per slug, matching the pass-through pinning the
 * upstream API itself supports.
 */
export function resolveLlmrouterDynamicModel(modelId: string): ProviderRuntimeModel | undefined {
  const id = modelId.trim();
  if (!id || LLMROUTER_MODEL_CATALOG.some((model) => model.id === id)) {
    return undefined;
  }
  return {
    id,
    name: id,
    provider: "llmrouter",
    api: "openai-completions",
    baseUrl: LLMROUTER_BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    maxTokens: LLMROUTER_DYNAMIC_MODEL_MAX_TOKENS,
  };
}
