import type { ModelCatalog, ModelCatalogDiscovery, NormalizedModelCatalogRow } from "./types.js";
type ManifestModelCatalogPlugin = {
    id: string;
    providers?: readonly string[];
    modelCatalog?: Pick<ModelCatalog, "providers" | "aliases" | "suppressions" | "discovery">;
};
type ManifestModelCatalogRegistry = {
    plugins: readonly ManifestModelCatalogPlugin[];
};
type ManifestModelCatalogPlanEntry = {
    pluginId: string;
    provider: string;
    discovery?: ModelCatalogDiscovery;
    rows: readonly NormalizedModelCatalogRow[];
};
type ManifestModelCatalogConflict = {
    mergeKey: string;
    ref: string;
    provider: string;
    modelId: string;
    firstPluginId: string;
    secondPluginId: string;
};
type ManifestModelCatalogPlan = {
    rows: readonly NormalizedModelCatalogRow[];
    entries: readonly ManifestModelCatalogPlanEntry[];
    conflicts: readonly ManifestModelCatalogConflict[];
};
export type ManifestModelCatalogSuppressionEntry = {
    pluginId: string;
    provider: string;
    model: string;
    mergeKey: string;
    reason?: string;
    when?: NonNullable<ModelCatalog["suppressions"]>[number]["when"];
};
type ManifestModelCatalogSuppressionPlan = {
    suppressions: readonly ManifestModelCatalogSuppressionEntry[];
};
export declare function planManifestModelCatalogRows(params: {
    registry: ManifestModelCatalogRegistry;
    providerFilter?: string;
}): ManifestModelCatalogPlan;
export declare function planManifestModelCatalogSuppressions(params: {
    registry: ManifestModelCatalogRegistry;
    providerFilter?: string;
    modelFilter?: string;
}): ManifestModelCatalogSuppressionPlan;
export {};
