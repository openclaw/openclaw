import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
export type ProviderModelIdNormalizationOptions = {
    allowManifestNormalization?: boolean;
    manifestPlugins?: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
};
export declare function modelKey(provider: string, model: string): string;
export declare function normalizeStaticProviderModelId(provider: string, model: string, options?: ProviderModelIdNormalizationOptions): string;
export declare function normalizeConfiguredProviderCatalogModelId(provider: string, model: string, options?: ProviderModelIdNormalizationOptions): string;
export declare function resolveStaticAllowlistModelKey(raw: string, defaultProvider: string): string | null;
export declare function formatLiteralProviderPrefixedModelRef(provider: string, modelRef: string): string;
