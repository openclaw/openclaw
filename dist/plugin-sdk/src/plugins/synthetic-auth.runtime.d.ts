import type { LoadPluginRegistryParams, PluginRegistrySnapshot } from "./plugin-registry.js";
type SyntheticAuthProviderRefParams = LoadPluginRegistryParams & {
    index?: PluginRegistrySnapshot;
    registryDiagnostics?: readonly unknown[];
};
export declare function resolveRuntimeSyntheticAuthProviderRefs(params?: SyntheticAuthProviderRefParams): string[];
export declare function resolveRuntimeSyntheticAuthProviderRefState(params?: SyntheticAuthProviderRefParams): {
    refs: string[];
    complete: boolean;
};
export declare function resolveRuntimeExternalAuthProviderRefs(params?: SyntheticAuthProviderRefParams): string[];
export {};
