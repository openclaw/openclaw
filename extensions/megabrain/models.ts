// MegaBrain plugin module implements models behavior.
import {
  getCachedLiveProviderModelRows,
  LiveModelCatalogHttpError,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { asPositiveSafeInteger } from "openclaw/plugin-sdk/string-coerce-runtime";

export const MEGABRAIN_PROVIDER_ID = "megabrain";
export const MEGABRAIN_BASE_URL = "https://getmegabrain.com/api/gateway/v1";
export const MEGABRAIN_DEFAULT_MODEL_ID = "openai/gpt-4o";
export const MEGABRAIN_DEFAULT_CONTEXT_WINDOW = 128_000;
export const MEGABRAIN_DEFAULT_MAX_TOKENS = 8_192;
export const MEGABRAIN_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

const log = createSubsystemLogger("agents/megabrain");
const MEGABRAIN_DISCOVERY_CACHE_TTL_MS = 60_000;
const MEGABRAIN_DISCOVERY_TIMEOUT_MS = 5_000;

type OpenAIModelShape = {
  id?: string;
  object?: string;
  context_window?: number;
  max_tokens?: number;
};

// A minimal static catalog so the provider works out-of-the-box without a
// network call.  MegaBrain exposes 500+ models via its /v1/models endpoint;
// the live discovery below will supersede this list at runtime.
const STATIC_MEGABRAIN_MODEL_CATALOG: readonly ModelDefinitionConfig[] = [
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: MEGABRAIN_DEFAULT_COST,
  },
  {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o Mini",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: MEGABRAIN_DEFAULT_COST,
  },
  {
    id: "anthropic/claude-opus-4.6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: MEGABRAIN_DEFAULT_COST,
  },
  {
    id: "anthropic/claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    cost: MEGABRAIN_DEFAULT_COST,
  },
  {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    cost: MEGABRAIN_DEFAULT_COST,
  },
] as const;

function buildDiscoveredModelDefinition(model: OpenAIModelShape): ModelDefinitionConfig | null {
  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (!id) {
    return null;
  }
  const contextWindow =
    asPositiveSafeInteger(model.context_window) ?? MEGABRAIN_DEFAULT_CONTEXT_WINDOW;
  const maxTokens = asPositiveSafeInteger(model.max_tokens) ?? MEGABRAIN_DEFAULT_MAX_TOKENS;
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    contextWindow,
    maxTokens,
    cost: MEGABRAIN_DEFAULT_COST,
  };
}

function asOpenAIModelShape(value: unknown): OpenAIModelShape {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("MegaBrain model list: malformed JSON response");
  }
  return value as OpenAIModelShape;
}

export function getStaticMegaBrainModelCatalog(): ModelDefinitionConfig[] {
  return [...STATIC_MEGABRAIN_MODEL_CATALOG];
}

export async function discoverMegaBrainModels(): Promise<ModelDefinitionConfig[]> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return getStaticMegaBrainModelCatalog();
  }

  try {
    const data = await getCachedLiveProviderModelRows({
      providerId: MEGABRAIN_PROVIDER_ID,
      endpoint: `${MEGABRAIN_BASE_URL}/models`,
      timeoutMs: MEGABRAIN_DISCOVERY_TIMEOUT_MS,
      ttlMs: MEGABRAIN_DISCOVERY_CACHE_TTL_MS,
      auditContext: "megabrain.models",
    });
    const discovered = data
      .map(asOpenAIModelShape)
      .map(buildDiscoveredModelDefinition)
      .filter((entry): entry is ModelDefinitionConfig => entry !== null);
    return discovered.length > 0 ? discovered : getStaticMegaBrainModelCatalog();
  } catch (error) {
    if (error instanceof LiveModelCatalogHttpError) {
      log.warn(`Failed to discover MegaBrain models: HTTP ${error.status}`);
      return getStaticMegaBrainModelCatalog();
    }
    log.warn(`Failed to discover MegaBrain models: ${String(error)}`);
    return getStaticMegaBrainModelCatalog();
  }
}
