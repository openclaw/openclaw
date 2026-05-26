import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { s as ModelDefinitionConfig, u as ModelProviderConfig } from "./types.models-tqxsISRc.js";
//#region src/plugin-sdk/lmstudio-runtime.d.ts
type LmstudioReasoningCapabilityWire = {
  allowed_options?: unknown;
  default?: unknown;
};
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
  contextWindow: number;
  contextTokens: number;
  maxTokens: number;
};
type FetchLmstudioModelsResult = {
  reachable: boolean;
  status?: number;
  models: LmstudioModelWire[];
  error?: unknown;
};
type FacadeModule = {
  LMSTUDIO_DEFAULT_BASE_URL: string;
  LMSTUDIO_DEFAULT_INFERENCE_BASE_URL: string;
  LMSTUDIO_DEFAULT_EMBEDDING_MODEL: string;
  LMSTUDIO_PROVIDER_LABEL: string;
  LMSTUDIO_DEFAULT_API_KEY_ENV_VAR: string;
  LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER: string;
  LMSTUDIO_MODEL_PLACEHOLDER: string;
  LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH: number;
  LMSTUDIO_DEFAULT_MODEL_ID: string;
  LMSTUDIO_PROVIDER_ID: string;
  resolveLmstudioReasoningCapability: (entry: Pick<LmstudioModelWire, "capabilities">) => boolean;
  resolveLoadedContextWindow: (entry: Pick<LmstudioModelWire, "loaded_instances">) => number | null;
  resolveLmstudioServerBase: (configuredBaseUrl?: string) => string;
  resolveLmstudioInferenceBase: (configuredBaseUrl?: string) => string;
  normalizeLmstudioProviderConfig: (provider: ModelProviderConfig) => ModelProviderConfig;
  fetchLmstudioModels: (params?: {
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
    ssrfPolicy?: unknown;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  }) => Promise<FetchLmstudioModelsResult>;
  mapLmstudioWireEntry: (entry: LmstudioModelWire) => LmstudioModelBase | null;
  discoverLmstudioModels: (params?: {
    config?: OpenClawConfig;
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
  }) => Promise<ModelDefinitionConfig[]>;
  ensureLmstudioModelLoaded: (params: Record<string, unknown>) => Promise<unknown>;
  buildLmstudioAuthHeaders: (params: {
    apiKey?: string;
    json?: boolean;
    headers?: Record<string, string>;
  }) => Record<string, string> | undefined;
  resolveLmstudioConfiguredApiKey: (params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    path?: string;
  }) => Promise<string | undefined>;
  resolveLmstudioProviderHeaders: (params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    headers?: unknown;
    path?: string;
  }) => Promise<Record<string, string> | undefined>;
  resolveLmstudioRequestContext: (params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    headers?: unknown;
    providerHeaders?: unknown;
    path?: string;
  }) => Promise<{
    apiKey?: string;
    headers?: Record<string, string>;
  }>;
  resolveLmstudioRuntimeApiKey: (params: {
    config?: OpenClawConfig;
    agentDir?: string;
    env?: NodeJS.ProcessEnv;
    headers?: unknown;
  }) => Promise<string | undefined>;
};
declare const LMSTUDIO_DEFAULT_BASE_URL: FacadeModule["LMSTUDIO_DEFAULT_BASE_URL"];
declare const LMSTUDIO_DEFAULT_INFERENCE_BASE_URL: FacadeModule["LMSTUDIO_DEFAULT_INFERENCE_BASE_URL"];
declare const LMSTUDIO_DEFAULT_EMBEDDING_MODEL: FacadeModule["LMSTUDIO_DEFAULT_EMBEDDING_MODEL"];
declare const LMSTUDIO_PROVIDER_LABEL: FacadeModule["LMSTUDIO_PROVIDER_LABEL"];
declare const LMSTUDIO_DEFAULT_API_KEY_ENV_VAR: FacadeModule["LMSTUDIO_DEFAULT_API_KEY_ENV_VAR"];
declare const LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER: FacadeModule["LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER"];
declare const LMSTUDIO_MODEL_PLACEHOLDER: FacadeModule["LMSTUDIO_MODEL_PLACEHOLDER"];
declare const LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH: FacadeModule["LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH"];
declare const LMSTUDIO_DEFAULT_MODEL_ID: FacadeModule["LMSTUDIO_DEFAULT_MODEL_ID"];
declare const LMSTUDIO_PROVIDER_ID: FacadeModule["LMSTUDIO_PROVIDER_ID"];
declare const resolveLmstudioReasoningCapability: FacadeModule["resolveLmstudioReasoningCapability"];
declare const resolveLoadedContextWindow: FacadeModule["resolveLoadedContextWindow"];
declare const resolveLmstudioServerBase: FacadeModule["resolveLmstudioServerBase"];
declare const resolveLmstudioInferenceBase: FacadeModule["resolveLmstudioInferenceBase"];
declare const normalizeLmstudioProviderConfig: FacadeModule["normalizeLmstudioProviderConfig"];
declare const fetchLmstudioModels: FacadeModule["fetchLmstudioModels"];
declare const mapLmstudioWireEntry: FacadeModule["mapLmstudioWireEntry"];
declare const discoverLmstudioModels: FacadeModule["discoverLmstudioModels"];
declare const ensureLmstudioModelLoaded: FacadeModule["ensureLmstudioModelLoaded"];
declare const buildLmstudioAuthHeaders: FacadeModule["buildLmstudioAuthHeaders"];
declare const resolveLmstudioConfiguredApiKey: FacadeModule["resolveLmstudioConfiguredApiKey"];
declare const resolveLmstudioProviderHeaders: FacadeModule["resolveLmstudioProviderHeaders"];
declare const resolveLmstudioRequestContext: FacadeModule["resolveLmstudioRequestContext"];
declare const resolveLmstudioRuntimeApiKey: FacadeModule["resolveLmstudioRuntimeApiKey"];
//#endregion
export { resolveLmstudioReasoningCapability as C, resolveLoadedContextWindow as D, resolveLmstudioServerBase as E, resolveLmstudioProviderHeaders as S, resolveLmstudioRuntimeApiKey as T, fetchLmstudioModels as _, LMSTUDIO_DEFAULT_INFERENCE_BASE_URL as a, resolveLmstudioConfiguredApiKey as b, LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER as c, LMSTUDIO_PROVIDER_LABEL as d, LmstudioModelBase as f, ensureLmstudioModelLoaded as g, discoverLmstudioModels as h, LMSTUDIO_DEFAULT_EMBEDDING_MODEL as i, LMSTUDIO_MODEL_PLACEHOLDER as l, buildLmstudioAuthHeaders as m, LMSTUDIO_DEFAULT_API_KEY_ENV_VAR as n, LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH as o, LmstudioModelWire as p, LMSTUDIO_DEFAULT_BASE_URL as r, LMSTUDIO_DEFAULT_MODEL_ID as s, FetchLmstudioModelsResult as t, LMSTUDIO_PROVIDER_ID as u, mapLmstudioWireEntry as v, resolveLmstudioRequestContext as w, resolveLmstudioInferenceBase as x, normalizeLmstudioProviderConfig as y };