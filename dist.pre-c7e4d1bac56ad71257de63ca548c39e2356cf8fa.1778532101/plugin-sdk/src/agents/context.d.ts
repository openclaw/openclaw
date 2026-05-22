import type { OpenClawConfig } from "../config/types.openclaw.js";
export { resetContextWindowCacheForTest } from "./context-runtime-state.js";
type ModelEntry = {
    id: string;
    provider?: string;
    contextWindow?: number;
    contextTokens?: number;
};
type ConfigModelEntry = {
    id?: string;
    contextWindow?: number;
    contextTokens?: number;
};
type ProviderConfigEntry = {
    contextWindow?: number;
    contextTokens?: number;
    models?: ConfigModelEntry[];
};
type ModelsConfig = {
    providers?: Record<string, ProviderConfigEntry | undefined>;
};
export declare const ANTHROPIC_CONTEXT_1M_TOKENS = 1048576;
export declare function applyDiscoveredContextWindows(params: {
    cache: Map<string, number>;
    models: ModelEntry[];
}): void;
export declare function applyConfiguredContextWindows(params: {
    cache: Map<string, number>;
    modelsConfig: ModelsConfig | undefined;
}): void;
export declare function shouldEagerWarmContextWindowCache(argv?: string[]): boolean;
export declare function lookupContextTokens(modelId?: string, options?: {
    allowAsyncLoad?: boolean;
}): number | undefined;
export declare function resolveContextTokensForModel(params: {
    cfg?: OpenClawConfig;
    provider?: string;
    model?: string;
    contextTokensOverride?: number;
    fallbackContextTokens?: number;
    allowAsyncLoad?: boolean;
}): number | undefined;
