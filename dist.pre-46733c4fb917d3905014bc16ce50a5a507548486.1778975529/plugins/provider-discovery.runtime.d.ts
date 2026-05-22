import { i as OpenClawConfig } from "../types.openclaw-C5VNg6h3.js";
import { t as PluginMetadataRegistryView } from "../plugin-metadata-snapshot.types-B7dt5aoR.js";
import { rn as ProviderPlugin } from "../types-Dggwf5Fv.js";

//#region src/plugins/provider-discovery.runtime.d.ts
declare function resolvePluginDiscoveryProvidersRuntime(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
  includeUntrustedWorkspacePlugins?: boolean;
  requireCompleteDiscoveryEntryCoverage?: boolean;
  discoveryEntriesOnly?: boolean;
  pluginMetadataSnapshot?: PluginMetadataRegistryView;
}): ProviderPlugin[];
//#endregion
export { resolvePluginDiscoveryProvidersRuntime };