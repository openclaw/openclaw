import type { ModelCatalogEntry, ModelInputType } from "./model-catalog.types.js";
export declare function modelSupportsInput(entry: ModelCatalogEntry | undefined, input: ModelInputType): boolean;
export declare function findModelInCatalog(catalog: ModelCatalogEntry[], provider: string, modelId: string): ModelCatalogEntry | undefined;
export declare function findModelCatalogEntry(catalog: ModelCatalogEntry[], params: {
    provider?: string;
    modelId: string;
}): ModelCatalogEntry | undefined;
