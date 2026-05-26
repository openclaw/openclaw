import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
export type { ModelCatalogEntry, ModelInputType } from "./model-catalog.types.js";
export { findModelCatalogEntry, findModelInCatalog, modelSupportsInput, } from "./model-catalog-lookup.js";
type PiSdkModule = typeof import("./pi-model-discovery-runtime.js");
export declare function resetModelCatalogCache(): void;
export declare function resetModelCatalogCacheForTest(): void;
export declare function setModelCatalogImportForTest(loader?: () => Promise<PiSdkModule>): void;
/** @deprecated Use `setModelCatalogImportForTest`. */
export { setModelCatalogImportForTest as __setModelCatalogImportForTest };
export declare function loadManifestModelCatalog(params: {
    config: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    fallbackToMetadataScan?: boolean;
    metadataSnapshot?: PluginMetadataSnapshot;
}): ModelCatalogEntry[];
export declare function loadModelCatalog(params?: {
    config?: OpenClawConfig;
    useCache?: boolean;
    readOnly?: boolean;
    metadataSnapshot?: PluginMetadataSnapshot;
}): Promise<ModelCatalogEntry[]>;
/**
 * Check if a model supports image input based on its catalog entry.
 */
export declare function modelSupportsVision(entry: ModelCatalogEntry | undefined): boolean;
/**
 * Check if a model supports native document/PDF input based on its catalog entry.
 */
export declare function modelSupportsDocument(entry: ModelCatalogEntry | undefined): boolean;
