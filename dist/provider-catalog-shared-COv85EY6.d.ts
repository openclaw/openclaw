import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { f as ModelProviderDeclarationConfig, u as ModelProviderConfig } from "./types.models-tqxsISRc.js";
import { Lt as ProviderCatalogContext, zt as ProviderCatalogResult } from "./types-Vx7Jq4_-2.js";
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
}): ModelProviderDeclarationConfig;
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
  providerConfig: ModelProviderDeclarationConfig;
}): ModelProviderDeclarationConfig;
//#endregion
export { getCachedLiveCatalogValue as a, buildPairedProviderApiKeyCatalog as c, clearLiveCatalogCacheForTests as i, buildSingleProviderApiKeyCatalog as l, applyProviderNativeStreamingUsageCompat as n, readConfiguredProviderCatalogEntries as o, buildManifestModelProviderConfig as r, supportsNativeStreamingUsageCompat as s, ConfiguredProviderCatalogEntry as t, findCatalogTemplate as u };