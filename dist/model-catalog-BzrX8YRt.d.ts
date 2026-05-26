import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { n as PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types-CemL6rws.js";
import { n as ModelInputType, t as ModelCatalogEntry } from "./model-catalog.types-LYni1Yjz.js";
import { t as pi_model_discovery_runtime_d_exports } from "./pi-model-discovery-runtime-C13Xu0-R.js";

//#region src/agents/model-catalog-lookup.d.ts
declare function modelSupportsInput(entry: ModelCatalogEntry | undefined, input: ModelInputType): boolean;
declare function findModelInCatalog(catalog: ModelCatalogEntry[], provider: string, modelId: string): ModelCatalogEntry | undefined;
declare function findModelCatalogEntry(catalog: ModelCatalogEntry[], params: {
  provider?: string;
  modelId: string;
}): ModelCatalogEntry | undefined;
//#endregion
//#region src/agents/model-catalog.d.ts
type PiSdkModule = typeof pi_model_discovery_runtime_d_exports;
declare function resetModelCatalogCache(): void;
declare function resetModelCatalogCacheForTest(): void;
declare function setModelCatalogImportForTest(loader?: () => Promise<PiSdkModule>): void;
declare function loadManifestModelCatalog(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  fallbackToMetadataScan?: boolean;
  metadataSnapshot?: PluginMetadataSnapshot;
}): ModelCatalogEntry[];
declare function loadModelCatalog(params?: {
  config?: OpenClawConfig;
  useCache?: boolean;
  readOnly?: boolean;
  metadataSnapshot?: PluginMetadataSnapshot;
}): Promise<ModelCatalogEntry[]>;
/**
 * Check if a model supports image input based on its catalog entry.
 */
declare function modelSupportsVision(entry: ModelCatalogEntry | undefined): boolean;
/**
 * Check if a model supports native document/PDF input based on its catalog entry.
 */
declare function modelSupportsDocument(entry: ModelCatalogEntry | undefined): boolean;
//#endregion
export { resetModelCatalogCache as a, findModelCatalogEntry as c, modelSupportsVision as i, findModelInCatalog as l, loadModelCatalog as n, resetModelCatalogCacheForTest as o, modelSupportsDocument as r, setModelCatalogImportForTest as s, loadManifestModelCatalog as t, modelSupportsInput as u };