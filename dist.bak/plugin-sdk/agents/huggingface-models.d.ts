import type { ModelDefinitionConfig } from "../config/types.models.js";
/** Hugging Face Inference Providers (router) — OpenAI-compatible chat completions. */
export declare const HUGGINGFACE_BASE_URL = "https://router.huggingface.co/v1";
/** Router policy suffixes: router picks backend by cost or speed; no specific provider selection. */
export declare const HUGGINGFACE_POLICY_SUFFIXES: readonly ["cheapest", "fastest"];
/**
 * True when the model ref uses :cheapest or :fastest. When true, provider choice is locked
 * (router decides); do not show an interactive "prefer specific backend" option.
 */
export declare function isHuggingfacePolicyLocked(modelRef: string): boolean;
export declare const HUGGINGFACE_MODEL_CATALOG: ModelDefinitionConfig[];
export declare function buildHuggingfaceModelDefinition(model: (typeof HUGGINGFACE_MODEL_CATALOG)[number]): ModelDefinitionConfig;
/**
 * Discover chat-completion models from Hugging Face Inference Providers (GET /v1/models).
 * Requires a valid HF token. Falls back to static catalog on failure or in test env.
 */
export declare function discoverHuggingfaceModels(apiKey: string): Promise<ModelDefinitionConfig[]>;
