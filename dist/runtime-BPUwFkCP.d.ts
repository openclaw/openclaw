import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { f as ModelProviderDeclarationConfig, s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
//#region extensions/lmstudio/src/defaults.d.ts
/** Shared LM Studio defaults used by setup, runtime discovery, and embeddings paths. */
declare const LMSTUDIO_DEFAULT_BASE_URL = "http://localhost:1234";
declare const LMSTUDIO_DEFAULT_INFERENCE_BASE_URL = "http://localhost:1234/v1";
declare const LMSTUDIO_DOCKER_HOST_BASE_URL = "http://host.docker.internal:1234";
declare const LMSTUDIO_DOCKER_HOST_INFERENCE_BASE_URL = "http://host.docker.internal:1234/v1";
declare const LMSTUDIO_DEFAULT_EMBEDDING_MODEL = "text-embedding-nomic-embed-text-v1.5";
declare const LMSTUDIO_PROVIDER_LABEL = "LM Studio";
declare const LMSTUDIO_DEFAULT_API_KEY_ENV_VAR = "LM_API_TOKEN";
declare const LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER = "lmstudio-local";
declare const LMSTUDIO_MODEL_PLACEHOLDER = "model-key-from-api-v1-models";
declare const LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH = 64000;
declare const LMSTUDIO_DEFAULT_MODEL_ID = "qwen/qwen3.5-9b";
declare const LMSTUDIO_PROVIDER_ID = "lmstudio";
//#endregion
//#region extensions/lmstudio/src/models.d.ts
type LmstudioModelWire = {
  type?: "llm" | "embedding";
  key?: string;
  display_name?: string;
  max_context_length?: number;
  format?: "gguf" | "mlx" | null;
  capabilities?: {
    vision?: boolean;
    trained_for_tool_use?: boolean;
    reasoning?: LmstudioReasoningCapabilityWire;
  };
  loaded_instances?: Array<{
    id?: string;
    config?: {
      context_length?: number;
    } | null;
  } | null>;
};
type LmstudioReasoningCapabilityWire = {
  allowed_options?: unknown;
  default?: unknown;
};
type LmstudioConfiguredCatalogEntry = {
  id: string;
  name?: string;
  contextWindow?: number;
  contextTokens?: number;
  reasoning?: boolean;
  input?: ("text" | "image" | "document")[];
  compat?: ModelDefinitionConfig["compat"];
};
declare function resolveLmstudioReasoningCompat(entry: Pick<LmstudioModelWire, "capabilities">): ModelDefinitionConfig["compat"] | undefined;
/**
 * Resolves LM Studio reasoning support from capabilities payloads.
 * Defaults to false when the server omits reasoning metadata.
 */
declare function resolveLmstudioReasoningCapability(entry: Pick<LmstudioModelWire, "capabilities">): boolean;
/**
 * Reads loaded LM Studio instances and returns the largest valid context window.
 * Returns null when no usable loaded context is present.
 */
declare function resolveLoadedContextWindow(entry: Pick<LmstudioModelWire, "loaded_instances">): number | null;
/** Resolves LM Studio server base URL (without /v1 or /api/v1). */
declare function resolveLmstudioServerBase(configuredBaseUrl?: string): string;
/** Resolves LM Studio inference base URL and always appends /v1. */
declare function resolveLmstudioInferenceBase(configuredBaseUrl?: string): string;
/** Canonicalizes persisted LM Studio provider config to the inference base URL form. */
declare function normalizeLmstudioProviderConfig(provider: ModelProviderDeclarationConfig): ModelProviderDeclarationConfig;
declare function normalizeLmstudioConfiguredCatalogEntry(entry: unknown): LmstudioConfiguredCatalogEntry | null;
declare function normalizeLmstudioConfiguredCatalogEntries(models: unknown): LmstudioConfiguredCatalogEntry[];
declare function buildLmstudioModelName(model: {
  displayName: string;
  format: "gguf" | "mlx" | null;
  vision: boolean;
  trainedForToolUse: boolean;
  loaded: boolean;
}): string;
/**
 * Base model fields extracted from a single LM Studio wire entry.
 * Shared by the setup layer (persists simple names to config) and the runtime
 * discovery path (which enriches the name with format/state tags).
 */
type LmstudioModelBase = {
  id: string;
  displayName: string;
  format: "gguf" | "mlx" | null;
  vision: boolean;
  trainedForToolUse: boolean;
  loaded: boolean;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: ModelDefinitionConfig["cost"];
  compat?: ModelDefinitionConfig["compat"];
  contextWindow: number;
  contextTokens: number;
  maxTokens: number;
};
/**
 * Maps a single LM Studio wire entry to its base model fields.
 * Returns null for non-LLM entries or entries with no usable key.
 *
 * Shared by both the setup layer (persists simple names to config) and the
 * runtime discovery path (which enriches the name with format/state tags via
 * buildLmstudioModelName).
 */
declare function mapLmstudioWireEntry(entry: LmstudioModelWire): LmstudioModelBase | null;
/**
 * Maps LM Studio wire models to config entries using plain display names.
 * Use this for config persistence where runtime format/state tags are not needed.
 * For runtime discovery with enriched names, use discoverLmstudioModels from models.fetch.ts.
 */
declare function mapLmstudioWireModelsToConfig(models: LmstudioModelWire[]): ModelDefinitionConfig[];
//#endregion
//#region extensions/lmstudio/src/runtime.d.ts
type LmstudioAuthHeadersParams = {
  apiKey?: string;
  json?: boolean;
  headers?: Record<string, string>;
};
declare function buildLmstudioAuthHeaders(params: LmstudioAuthHeadersParams): Record<string, string> | undefined;
declare function resolveLmstudioConfiguredApiKey(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  path?: string;
  allowUnresolved?: boolean;
}): Promise<string | undefined>;
declare function resolveLmstudioProviderHeaders(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  headers?: unknown;
  path?: string;
}): Promise<Record<string, string> | undefined>;
/**
 * Resolves LM Studio API key and provider headers in parallel.
 * Use this as the standard auth setup step before discovery or model load calls.
 */
declare function resolveLmstudioRequestContext(params: {
  config?: OpenClawConfig;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  providerHeaders?: unknown;
}): Promise<{
  apiKey: string | undefined;
  headers: Record<string, string> | undefined;
}>;
/**
 * Resolves LM Studio runtime API key from config.
 */
declare function resolveLmstudioRuntimeApiKey(params: {
  config?: OpenClawConfig;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  headers?: unknown;
}): Promise<string | undefined>;
//#endregion
export { LMSTUDIO_PROVIDER_LABEL as A, LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH as C, LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER as D, LMSTUDIO_DOCKER_HOST_INFERENCE_BASE_URL as E, LMSTUDIO_MODEL_PLACEHOLDER as O, LMSTUDIO_DEFAULT_INFERENCE_BASE_URL as S, LMSTUDIO_DOCKER_HOST_BASE_URL as T, resolveLmstudioServerBase as _, resolveLmstudioRuntimeApiKey as a, LMSTUDIO_DEFAULT_BASE_URL as b, buildLmstudioModelName as c, normalizeLmstudioConfiguredCatalogEntries as d, normalizeLmstudioConfiguredCatalogEntry as f, resolveLmstudioReasoningCompat as g, resolveLmstudioReasoningCapability as h, resolveLmstudioRequestContext as i, LMSTUDIO_PROVIDER_ID as k, mapLmstudioWireEntry as l, resolveLmstudioInferenceBase as m, resolveLmstudioConfiguredApiKey as n, LmstudioModelBase as o, normalizeLmstudioProviderConfig as p, resolveLmstudioProviderHeaders as r, LmstudioModelWire as s, buildLmstudioAuthHeaders as t, mapLmstudioWireModelsToConfig as u, resolveLoadedContextWindow as v, LMSTUDIO_DEFAULT_MODEL_ID as w, LMSTUDIO_DEFAULT_EMBEDDING_MODEL as x, LMSTUDIO_DEFAULT_API_KEY_ENV_VAR as y };