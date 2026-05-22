import { i as OpenClawConfig } from "../types.openclaw-Bpxi7OSY.js";
import { t as PluginMetadataRegistryView } from "../plugin-metadata-snapshot.types-CfzHjgmJ.js";
import { sn as ProviderPlugin } from "../types-Cdl1yOYR.js";

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