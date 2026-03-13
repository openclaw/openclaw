/**
 * OpenCode Zen model catalog with dynamic fetching, caching, and static fallback.
 *
 * OpenCode Zen is a pay-as-you-go token-based API that provides access to curated
 * models optimized for coding agents. It uses per-request billing with auto top-up.
 *
 * Note: OpenCode Black ($20/$100/$200/month subscriptions) is a separate product
 * with flat-rate usage tiers. This module handles Zen, not Black.
 *
 * API endpoint: https://opencode.ai/zen/v1
 * Auth URL: https://opencode.ai/auth
 */
import type { ModelApi, ModelDefinitionConfig } from "../config/types.js";
export declare const OPENCODE_ZEN_API_BASE_URL = "https://opencode.ai/zen/v1";
export declare const OPENCODE_ZEN_DEFAULT_MODEL = "claude-opus-4-6";
export declare const OPENCODE_ZEN_DEFAULT_MODEL_REF = "opencode/claude-opus-4-6";
/**
 * Model aliases for convenient shortcuts.
 * Users can use "opus" instead of "claude-opus-4-6", etc.
 */
export declare const OPENCODE_ZEN_MODEL_ALIASES: Record<string, string>;
/**
 * Resolve a model alias to its full model ID.
 * Returns the input if no alias exists.
 */
export declare function resolveOpencodeZenAlias(modelIdOrAlias: string): string;
/**
 * OpenCode Zen routes models to specific API shapes by family.
 */
export declare function resolveOpencodeZenModelApi(modelId: string): ModelApi;
/**
 * Static fallback models when API is unreachable.
 */
export declare function getOpencodeZenStaticFallbackModels(): ModelDefinitionConfig[];
/**
 * Fetch models from the OpenCode Zen API.
 * Uses caching with 1-hour TTL.
 *
 * @param apiKey - OpenCode Zen API key for authentication
 * @returns Array of model definitions, or static fallback on failure
 */
export declare function fetchOpencodeZenModels(apiKey?: string): Promise<ModelDefinitionConfig[]>;
/**
 * Clear the model cache (useful for testing or forcing refresh).
 */
export declare function clearOpencodeZenModelCache(): void;
