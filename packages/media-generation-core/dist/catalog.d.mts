//#region src/catalog.d.ts
type MediaGenerationCatalogKind = "image_generation" | "video_generation" | "music_generation";
type MediaGenerationCatalogSource = "static" | "live" | "cache" | "configured";
type MediaGenerationCatalogEntry<TCapabilities = unknown> = {
  kind: MediaGenerationCatalogKind;
  provider: string;
  model: string;
  label?: string;
  source: MediaGenerationCatalogSource;
  default?: boolean;
  configured?: boolean;
  capabilities?: TCapabilities;
  modes?: readonly string[];
  authEnvVars?: readonly string[];
  docsPath?: string;
  fetchedAt?: number;
  expiresAt?: number;
  warnings?: readonly string[];
};
type MediaGenerationCatalogProvider<TCapabilities = unknown> = {
  id: string;
  aliases?: readonly string[];
  label?: string;
  defaultModel?: string;
  models?: readonly string[];
  capabilities: TCapabilities;
};
declare function synthesizeMediaGenerationCatalogEntries<TCapabilities>(params: {
  kind: MediaGenerationCatalogKind;
  provider: MediaGenerationCatalogProvider<TCapabilities>;
  modes?: readonly string[];
}): Array<MediaGenerationCatalogEntry<TCapabilities>>;
declare function listMediaGenerationProviderModels(provider: {
  defaultModel?: string;
  models?: readonly string[];
}): string[];
//#endregion
export { MediaGenerationCatalogEntry, MediaGenerationCatalogKind, MediaGenerationCatalogProvider, MediaGenerationCatalogSource, listMediaGenerationProviderModels, synthesizeMediaGenerationCatalogEntries };