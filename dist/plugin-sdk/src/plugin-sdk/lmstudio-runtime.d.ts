import type { ModelDefinitionConfig, ModelProviderConfig, OpenClawConfig } from "../config/types.js";
type LmstudioReasoningCapabilityWire = {
    allowed_options?: unknown;
    default?: unknown;
};
export type LmstudioModelWire = {
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
export type LmstudioModelBase = {
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
export type FetchLmstudioModelsResult = {
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
export declare const LMSTUDIO_DEFAULT_BASE_URL: FacadeModule["LMSTUDIO_DEFAULT_BASE_URL"];
export declare const LMSTUDIO_DEFAULT_INFERENCE_BASE_URL: FacadeModule["LMSTUDIO_DEFAULT_INFERENCE_BASE_URL"];
export declare const LMSTUDIO_DEFAULT_EMBEDDING_MODEL: FacadeModule["LMSTUDIO_DEFAULT_EMBEDDING_MODEL"];
export declare const LMSTUDIO_PROVIDER_LABEL: FacadeModule["LMSTUDIO_PROVIDER_LABEL"];
export declare const LMSTUDIO_DEFAULT_API_KEY_ENV_VAR: FacadeModule["LMSTUDIO_DEFAULT_API_KEY_ENV_VAR"];
export declare const LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER: FacadeModule["LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER"];
export declare const LMSTUDIO_MODEL_PLACEHOLDER: FacadeModule["LMSTUDIO_MODEL_PLACEHOLDER"];
export declare const LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH: FacadeModule["LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH"];
export declare const LMSTUDIO_DEFAULT_MODEL_ID: FacadeModule["LMSTUDIO_DEFAULT_MODEL_ID"];
export declare const LMSTUDIO_PROVIDER_ID: FacadeModule["LMSTUDIO_PROVIDER_ID"];
export declare const resolveLmstudioReasoningCapability: FacadeModule["resolveLmstudioReasoningCapability"];
export declare const resolveLoadedContextWindow: FacadeModule["resolveLoadedContextWindow"];
export declare const resolveLmstudioServerBase: FacadeModule["resolveLmstudioServerBase"];
export declare const resolveLmstudioInferenceBase: FacadeModule["resolveLmstudioInferenceBase"];
export declare const normalizeLmstudioProviderConfig: FacadeModule["normalizeLmstudioProviderConfig"];
export declare const fetchLmstudioModels: FacadeModule["fetchLmstudioModels"];
export declare const mapLmstudioWireEntry: FacadeModule["mapLmstudioWireEntry"];
export declare const discoverLmstudioModels: FacadeModule["discoverLmstudioModels"];
export declare const ensureLmstudioModelLoaded: FacadeModule["ensureLmstudioModelLoaded"];
export declare const buildLmstudioAuthHeaders: FacadeModule["buildLmstudioAuthHeaders"];
export declare const resolveLmstudioConfiguredApiKey: FacadeModule["resolveLmstudioConfiguredApiKey"];
export declare const resolveLmstudioProviderHeaders: FacadeModule["resolveLmstudioProviderHeaders"];
export declare const resolveLmstudioRequestContext: FacadeModule["resolveLmstudioRequestContext"];
export declare const resolveLmstudioRuntimeApiKey: FacadeModule["resolveLmstudioRuntimeApiKey"];
export {};
