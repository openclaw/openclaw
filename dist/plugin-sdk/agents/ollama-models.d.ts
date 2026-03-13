import type { ModelDefinitionConfig } from "../config/types.models.js";
export declare const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
export declare const OLLAMA_DEFAULT_CONTEXT_WINDOW = 128000;
export declare const OLLAMA_DEFAULT_MAX_TOKENS = 8192;
export declare const OLLAMA_DEFAULT_COST: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
};
export type OllamaTagModel = {
    name: string;
    modified_at?: string;
    size?: number;
    digest?: string;
    remote_host?: string;
    details?: {
        family?: string;
        parameter_size?: string;
    };
};
export type OllamaTagsResponse = {
    models?: OllamaTagModel[];
};
export type OllamaModelWithContext = OllamaTagModel & {
    contextWindow?: number;
};
/**
 * Derive the Ollama native API base URL from a configured base URL.
 *
 * Users typically configure `baseUrl` with a `/v1` suffix (e.g.
 * `http://192.168.20.14:11434/v1`) for the OpenAI-compatible endpoint.
 * The native Ollama API lives at the root (e.g. `/api/tags`), so we
 * strip the `/v1` suffix when present.
 */
export declare function resolveOllamaApiBase(configuredBaseUrl?: string): string;
export declare function queryOllamaContextWindow(apiBase: string, modelName: string): Promise<number | undefined>;
export declare function enrichOllamaModelsWithContext(apiBase: string, models: OllamaTagModel[], opts?: {
    concurrency?: number;
}): Promise<OllamaModelWithContext[]>;
/** Heuristic: treat models with "r1", "reasoning", or "think" in the name as reasoning models. */
export declare function isReasoningModelHeuristic(modelId: string): boolean;
/** Build a ModelDefinitionConfig for an Ollama model with default values. */
export declare function buildOllamaModelDefinition(modelId: string, contextWindow?: number): ModelDefinitionConfig;
/** Fetch the model list from a running Ollama instance. */
export declare function fetchOllamaModels(baseUrl: string): Promise<{
    reachable: boolean;
    models: OllamaTagModel[];
}>;
