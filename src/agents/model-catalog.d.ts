import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
export type { ModelCatalogEntry, ModelInputType } from "./model-catalog.types.js";
type PiSdkModule = typeof import("./pi-model-discovery-runtime.js");
export declare function resetModelCatalogCache(): void;
export declare function resetModelCatalogCacheForTest(): void;
export declare function __setModelCatalogImportForTest(loader?: () => Promise<PiSdkModule>): void;
export declare function loadModelCatalog(params?: {
    config?: OpenClawConfig;
    useCache?: boolean;
    readOnly?: boolean;
}): Promise<ModelCatalogEntry[]>;
/**
 * Check if a model supports image input based on its catalog entry.
 */
export declare function modelSupportsVision(entry: ModelCatalogEntry | undefined): boolean;
/**
 * Check if a model supports native document/PDF input based on its catalog entry.
 */
export declare function modelSupportsDocument(entry: ModelCatalogEntry | undefined): boolean;
/**
 * Find a model in the catalog by provider and model ID.
 */
export declare function findModelInCatalog(catalog: ModelCatalogEntry[], provider: string, modelId: string): ModelCatalogEntry | undefined;
