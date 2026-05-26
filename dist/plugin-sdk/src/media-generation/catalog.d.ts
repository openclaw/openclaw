import type { UnifiedModelCatalogEntry, UnifiedModelCatalogKind, UnifiedModelCatalogSource } from "../model-catalog/types.js";
export type MediaGenerationCatalogKind = Exclude<UnifiedModelCatalogKind, "text">;
export type MediaGenerationCatalogSource = Extract<UnifiedModelCatalogSource, "static" | "live" | "cache" | "configured">;
export type MediaGenerationCatalogEntry<TCapabilities = unknown> = UnifiedModelCatalogEntry<TCapabilities> & {
    kind: MediaGenerationCatalogKind;
    source: MediaGenerationCatalogSource;
};
export type MediaGenerationCatalogProvider<TCapabilities = unknown> = {
    id: string;
    aliases?: readonly string[];
    label?: string;
    defaultModel?: string;
    models?: readonly string[];
    capabilities: TCapabilities;
};
export declare function synthesizeMediaGenerationCatalogEntries<TCapabilities>(params: {
    kind: MediaGenerationCatalogKind;
    provider: MediaGenerationCatalogProvider<TCapabilities>;
    modes?: readonly string[];
}): Array<MediaGenerationCatalogEntry<TCapabilities>>;
export declare function listMediaGenerationProviderModels(provider: {
    defaultModel?: string;
    models?: readonly string[];
}): string[];
