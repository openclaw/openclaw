import { i as OpenClawConfig } from "../types.openclaw-BlE9q7jU.js";
import { t as PluginMetadataRegistryView } from "../plugin-metadata-snapshot.types-DVq9Y-Wm.js";
import { nn as ProviderPlugin } from "../types-DKA4S1yN.js";

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