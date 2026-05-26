import type { PluginManifestContracts } from "./manifest.js";
export declare function normalizePluginToolContractNames(contracts: Pick<PluginManifestContracts, "tools"> | undefined): string[];
export declare function normalizePluginToolNames(names: readonly string[] | undefined): string[];
export declare function findUndeclaredPluginToolNames(params: {
    declaredNames: readonly string[];
    toolNames: readonly string[];
}): string[];
