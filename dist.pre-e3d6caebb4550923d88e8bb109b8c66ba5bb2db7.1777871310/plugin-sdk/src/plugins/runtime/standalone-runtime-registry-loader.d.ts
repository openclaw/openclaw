import { type ActiveRuntimePluginRegistrySurface } from "../active-runtime-registry.js";
import { type PluginLoadOptions } from "../loader.js";
import type { PluginRegistry } from "../registry-types.js";
export declare function ensureStandaloneRuntimePluginRegistryLoaded(params: {
    loadOptions: PluginLoadOptions;
    requiredPluginIds?: readonly string[];
    surface?: ActiveRuntimePluginRegistrySurface;
}): PluginRegistry | undefined;
