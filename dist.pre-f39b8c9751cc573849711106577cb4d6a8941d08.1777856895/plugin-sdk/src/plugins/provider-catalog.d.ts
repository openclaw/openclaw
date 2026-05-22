import type { ModelProviderConfig } from "../config/types.js";
import type { ProviderCatalogContext, ProviderCatalogResult } from "./types.js";
export declare function findCatalogTemplate(params: {
    entries: ReadonlyArray<{
        provider: string;
        id: string;
    }>;
    providerId: string;
    templateIds: readonly string[];
}): {
    provider: string;
    id: string;
} | undefined;
export declare function buildSingleProviderApiKeyCatalog(params: {
    ctx: ProviderCatalogContext;
    providerId: string;
    buildProvider: () => ModelProviderConfig | Promise<ModelProviderConfig>;
    allowExplicitBaseUrl?: boolean;
}): Promise<ProviderCatalogResult>;
export declare function buildPairedProviderApiKeyCatalog(params: {
    ctx: ProviderCatalogContext;
    providerId: string;
    buildProviders: () => Record<string, ModelProviderConfig> | Promise<Record<string, ModelProviderConfig>>;
}): Promise<ProviderCatalogResult>;
