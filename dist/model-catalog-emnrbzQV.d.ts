import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { n as ModelInputType, t as ModelCatalogEntry } from "./model-catalog.types-CRpxx7uE.js";
import { t as pi_model_discovery_runtime_d_exports } from "./pi-model-discovery-runtime-L_6b_Z4T.js";

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
declare function __setModelCatalogImportForTest(loader?: () => Promise<PiSdkModule>): void;
declare function loadManifestModelCatalog(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  fallbackToMetadataScan?: boolean;
}): ModelCatalogEntry[];
declare function loadModelCatalog(params?: {
  config?: OpenClawConfig;
  useCache?: boolean;
  readOnly?: boolean;
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
export { modelSupportsVision as a, findModelCatalogEntry as c, modelSupportsDocument as i, findModelInCatalog as l, loadManifestModelCatalog as n, resetModelCatalogCache as o, loadModelCatalog as r, resetModelCatalogCacheForTest as s, __setModelCatalogImportForTest as t, modelSupportsInput as u };