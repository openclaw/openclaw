import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
type LiveProviderModelConfig = string | {
    primary?: string;
    fallbacks?: readonly string[];
} | undefined;
export declare function redactLiveApiKey(value: string | undefined): string;
export declare function parseLiveCsvFilter(raw?: string, options?: {
    lowercase?: boolean;
}): Set<string> | null;
export declare function parseProviderModelMap(raw?: string): Map<string, string>;
export declare function resolveConfiguredLiveProviderModels(configured: LiveProviderModelConfig): Map<string, string>;
export declare function resolveLiveAuthStore(params: {
    requireProfileKeys: boolean;
    hasLiveKeys: boolean;
}): AuthProfileStore | undefined;
export {};
