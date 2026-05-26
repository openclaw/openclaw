import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { l as ModelProviderConfig } from "./types.models-CkWCv1xp.js";
import { Mt as ProviderCatalogContext, Pt as ProviderCatalogResult } from "./types-lCXG2pW_.js";
//#region src/plugins/provider-catalog.d.ts
declare function findCatalogTemplate(params: {
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
declare function buildSingleProviderApiKeyCatalog(params: {
  ctx: ProviderCatalogContext;
  providerId: string;
  buildProvider: () => ModelProviderConfig | Promise<ModelProviderConfig>;
  allowExplicitBaseUrl?: boolean;
}): Promise<ProviderCatalogResult>;
declare function buildPairedProviderApiKeyCatalog(params: {
  ctx: ProviderCatalogContext;
  providerId: string;
  buildProviders: () => Record<string, ModelProviderConfig> | Promise<Record<string, ModelProviderConfig>>;
}): Promise<ProviderCatalogResult>;
//#endregion
//#region src/plugin-sdk/provider-catalog-shared.d.ts
type ConfiguredProviderCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image" | "audio" | "video" | "document">;
};
declare function getCachedLiveCatalogValue<T>(params: {
  keyParts: readonly unknown[];
  load: () => Promise<T>;
  ttlMs?: number;
  now?: () => number;
}): Promise<T>;
declare function clearLiveCatalogCacheForTests(): void;
declare function buildManifestModelProviderConfig(params: {
  providerId: string;
  catalog: unknown;
}): ModelProviderConfig;
declare function readConfiguredProviderCatalogEntries(params: {
  config?: OpenClawConfig;
  providerId: string;
  publishedProviderId?: string;
}): ConfiguredProviderCatalogEntry[];
declare function supportsNativeStreamingUsageCompat(params: {
  providerId: string;
  baseUrl: string | undefined;
}): boolean;
declare function applyProviderNativeStreamingUsageCompat(params: {
  providerId: string;
  providerConfig: ModelProviderConfig;
}): ModelProviderConfig;
//#endregion
export { getCachedLiveCatalogValue as a, buildPairedProviderApiKeyCatalog as c, clearLiveCatalogCacheForTests as i, buildSingleProviderApiKeyCatalog as l, applyProviderNativeStreamingUsageCompat as n, readConfiguredProviderCatalogEntries as o, buildManifestModelProviderConfig as r, supportsNativeStreamingUsageCompat as s, ConfiguredProviderCatalogEntry as t, findCatalogTemplate as u };