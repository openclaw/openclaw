import { type OpenClawConfig } from "../config/config.js";
export type ModelInputType = "text" | "image" | "document";
export type ModelCatalogEntry = {
    id: string;
    name: string;
    provider: string;
    contextWindow?: number;
    reasoning?: boolean;
    input?: ModelInputType[];
};
type PiSdkModule = typeof import("./pi-model-discovery.js");
export declare function resetModelCatalogCacheForTest(): void;
export declare function __setModelCatalogImportForTest(loader?: () => Promise<PiSdkModule>): void;
export declare function loadModelCatalog(params?: {
    config?: OpenClawConfig;
    useCache?: boolean;
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
export {};
