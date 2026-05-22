import type { PluginRegistrySnapshot } from "./plugin-registry.js";
export declare function resolveRuntimeSyntheticAuthProviderRefs(params?: {
    index?: PluginRegistrySnapshot;
    registryDiagnostics?: readonly unknown[];
}): string[];
export declare function resolveRuntimeExternalAuthProviderRefs(params?: {
    index?: PluginRegistrySnapshot;
    registryDiagnostics?: readonly unknown[];
}): string[];
