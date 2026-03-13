import type { ProviderConfig } from "./models-config.providers.js";
export type ExistingProviderConfig = ProviderConfig & {
    apiKey?: string;
    baseUrl?: string;
    api?: string;
};
export declare function mergeProviderModels(implicit: ProviderConfig, explicit: ProviderConfig): ProviderConfig;
export declare function mergeProviders(params: {
    implicit?: Record<string, ProviderConfig> | null;
    explicit?: Record<string, ProviderConfig> | null;
}): Record<string, ProviderConfig>;
export declare function mergeWithExistingProviderSecrets(params: {
    nextProviders: Record<string, ProviderConfig>;
    existingProviders: Record<string, ExistingProviderConfig>;
    secretRefManagedProviders: ReadonlySet<string>;
    explicitBaseUrlProviders: ReadonlySet<string>;
}): Record<string, ProviderConfig>;
