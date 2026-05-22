import { i as OpenClawConfig } from "../types.openclaw-Cy0U3Gwh.js";
import { t as PluginMetadataRegistryView } from "../plugin-metadata-snapshot.types-CaBk2DMZ.js";
import { sn as ProviderPlugin } from "../types-Dw7_sm4q.js";

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