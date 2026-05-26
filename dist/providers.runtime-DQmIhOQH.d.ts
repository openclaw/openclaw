import { t as PluginMetadataRegistryView } from "./plugin-metadata-snapshot.types-CemL6rws.js";
import { sn as ProviderPlugin } from "./types-Vx7Jq4_-2.js";
import { n as PluginLoadOptions } from "./loader-DVJWgNxt.js";

//#region src/plugins/providers.runtime.d.ts
declare function isPluginProvidersLoadInFlight(params: Parameters<typeof resolvePluginProviders>[0]): boolean;
declare function resolvePluginProviders(params: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string; /** Use an explicit env when plugin roots should resolve independently from process.env. */
  env?: PluginLoadOptions["env"];
  bundledProviderAllowlistCompat?: boolean;
  bundledProviderVitestCompat?: boolean;
  onlyPluginIds?: string[];
  providerRefs?: readonly string[];
  modelRefs?: readonly string[];
  activate?: boolean;
  cache?: boolean;
  applyAutoEnable?: boolean;
  pluginSdkResolution?: PluginLoadOptions["pluginSdkResolution"];
  mode?: "runtime" | "setup";
  includeUntrustedWorkspacePlugins?: boolean;
  pluginMetadataSnapshot?: PluginMetadataRegistryView;
}): ProviderPlugin[];
//#endregion
export { resolvePluginProviders as n, isPluginProvidersLoadInFlight as t };