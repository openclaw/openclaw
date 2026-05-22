import { type ActiveRuntimePluginRegistrySurface } from "../active-runtime-registry.js";
import { type PluginLoadOptions } from "../loader.js";
import type { PluginRegistry } from "../registry-types.js";
export declare function ensureStandaloneRuntimePluginRegistryLoaded(params: {
    loadOptions: PluginLoadOptions;
    forceLoad?: boolean;
    installRegistry?: boolean;
    requiredPluginIds?: readonly string[];
    surface?: ActiveRuntimePluginRegistrySurface;
}): PluginRegistry | undefined;
