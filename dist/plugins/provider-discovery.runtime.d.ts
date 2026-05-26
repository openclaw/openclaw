import { i as OpenClawConfig } from "../types.openclaw-DIZy8jcb.js";
import { t as PluginMetadataRegistryView } from "../plugin-metadata-snapshot.types-B1XKSJMK.js";
import { nn as ProviderPlugin } from "../types-lCXG2pW_.js";

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