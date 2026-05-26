import { i as OpenClawConfig } from "../types.openclaw-BLF4DJTX.js";
import { t as PluginMetadataRegistryView } from "../plugin-metadata-snapshot.types-CemL6rws.js";
import { sn as ProviderPlugin } from "../types-Vx7Jq4_-2.js";

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