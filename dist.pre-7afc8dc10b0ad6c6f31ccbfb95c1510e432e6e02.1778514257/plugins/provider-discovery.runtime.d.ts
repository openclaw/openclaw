import { i as OpenClawConfig } from "../types.openclaw-C9E_zZnO.js";
import { t as PluginMetadataRegistryView } from "../plugin-metadata-snapshot.types-DiNPNiKE.js";
import { Jt as ProviderPlugin } from "../types-BOTb5nyG.js";

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