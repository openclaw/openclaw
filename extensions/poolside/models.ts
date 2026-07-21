/**
 * Poolside model catalog and compat metadata.
 *
 * Poolside serves the Laguna model family over an OpenAI-compatible API. The
 * catalog is static: it lists only the Laguna models, not every model the
 * Poolside endpoint proxies.
 */
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelCompatConfig,
  ModelDefinitionConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const POOLSIDE_MANIFEST_CATALOG = manifest.modelCatalog.providers.poolside;
const DEFAULT_CONTEXT_WINDOW = 262_144;
const DEFAULT_MAX_TOKENS = 32_768;

/**
 * Shared transport policy for every Laguna model.
 *
 * Laguna advertises `tools` and `reasoning` only: no `reasoning_effort`,
 * `json_mode`, or `structured_outputs`. `supportsReasoningEffort` stays false
 * so OpenClaw never sends a `reasoning_effort` field the endpoint rejects,
 * while `reasoning: true` still streams `reasoning_content` deltas.
 */
const POOLSIDE_COMPAT: ModelCompatConfig = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsUsageInStreaming: true,
  supportsStrictMode: false,
  supportsTools: true,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
};

/** Base URL for Poolside's OpenAI-compatible inference API. */
export const POOLSIDE_BASE_URL = POOLSIDE_MANIFEST_CATALOG.baseUrl;
/** Default Poolside model id used for onboarding. */
export const POOLSIDE_DEFAULT_MODEL_ID = "laguna-s-2.1";
/** Default Poolside model ref used for onboarding. */
export const POOLSIDE_DEFAULT_MODEL_REF = `poolside/${POOLSIDE_DEFAULT_MODEL_ID}`;
/** Bundled Laguna catalog rows shipped with this release. */
export const POOLSIDE_MODEL_CATALOG = POOLSIDE_MANIFEST_CATALOG.models;

/** Builds one normalized Poolside model definition from a manifest entry. */
export function buildPoolsideModelDefinition(
  model: (typeof POOLSIDE_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  const provider = buildManifestModelProviderConfig({
    providerId: "poolside",
    catalog: { ...POOLSIDE_MANIFEST_CATALOG, models: [model] },
  });
  const normalized = provider.models[0];
  if (!normalized) {
    throw new Error(`Missing normalized Poolside model ${model.id}`);
  }
  return {
    ...normalized,
    compat: { ...POOLSIDE_COMPAT, ...normalized.compat },
  };
}

/** Builds the full static Laguna catalog with shared compat applied. */
export function buildStaticPoolsideModels(): ModelDefinitionConfig[] {
  return POOLSIDE_MODEL_CATALOG.map(buildPoolsideModelDefinition);
}

/** Whether a model id is one of the bundled Laguna catalog rows. */
export function isPoolsideCatalogModelId(modelId: string): boolean {
  const id = modelId.trim();
  return POOLSIDE_MODEL_CATALOG.some((model) => model.id === id);
}

/** Resolves a forward-compatible Laguna model id not yet in the bundled catalog. */
export function resolvePoolsideDynamicModel(modelId: string): ProviderRuntimeModel | undefined {
  const id = modelId.trim();
  if (!id || isPoolsideCatalogModelId(id)) {
    return undefined;
  }
  return {
    id,
    name: id,
    provider: "poolside",
    api: "openai-completions" as const,
    baseUrl: POOLSIDE_BASE_URL,
    reasoning: true,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: { ...POOLSIDE_COMPAT },
  };
}
