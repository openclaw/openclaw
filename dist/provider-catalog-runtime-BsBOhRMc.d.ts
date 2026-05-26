import { n as PluginManifestRegistry } from "./manifest-registry-CMekBFSM.js";
import { r as augmentModelCatalogWithProviderPlugins } from "./provider-runtime-B73Bddav.js";
import { n as PluginLoadOptions } from "./loader-DVJWgNxt.js";
import { n as resolvePluginProviders, t as isPluginProvidersLoadInFlight } from "./providers.runtime-DQmIhOQH.js";

//#region src/plugins/providers.d.ts
declare function resolveOwningPluginIdsForProvider(params: {
  provider: string;
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
  manifestRegistry?: PluginManifestRegistry;
}): string[] | undefined;
declare function resolveCatalogHookProviderPluginIds(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env?: PluginLoadOptions["env"];
}): string[];
declare namespace provider_catalog_runtime_d_exports {
  export { augmentModelCatalogWithProviderPlugins, isPluginProvidersLoadInFlight, resolveCatalogHookProviderPluginIds, resolveOwningPluginIdsForProvider, resolvePluginProviders };
}
//#endregion
export { resolveCatalogHookProviderPluginIds as n, resolveOwningPluginIdsForProvider as r, provider_catalog_runtime_d_exports as t };