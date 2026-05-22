import { i as OpenClawConfig } from "../types.openclaw-DNoZmPZ8.js";
import { t as PluginMetadataRegistryView } from "../plugin-metadata-snapshot.types-C-6jda2e.js";
import { nn as ProviderPlugin } from "../types-CT4HF0Ri.js";

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