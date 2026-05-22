import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelProviderConfig } from "./provider-model-shared.js";
export type { ProviderCatalogContext, ProviderCatalogResult } from "../plugins/types.js";
export { buildPairedProviderApiKeyCatalog, buildSingleProviderApiKeyCatalog, findCatalogTemplate, } from "../plugins/provider-catalog.js";
export type ConfiguredProviderCatalogEntry = {
    id: string;
    name: string;
    provider: string;
    contextWindow?: number;
    reasoning?: boolean;
    input?: Array<"text" | "image" | "audio" | "video" | "document">;
};
export declare function buildManifestModelProviderConfig(params: {
    providerId: string;
    catalog: unknown;
}): ModelProviderConfig;
export declare function readConfiguredProviderCatalogEntries(params: {
    config?: OpenClawConfig;
    providerId: string;
    publishedProviderId?: string;
}): ConfiguredProviderCatalogEntry[];
export declare function supportsNativeStreamingUsageCompat(params: {
    providerId: string;
    baseUrl: string | undefined;
}): boolean;
export declare function applyProviderNativeStreamingUsageCompat(params: {
    providerId: string;
    providerConfig: ModelProviderConfig;
}): ModelProviderConfig;
