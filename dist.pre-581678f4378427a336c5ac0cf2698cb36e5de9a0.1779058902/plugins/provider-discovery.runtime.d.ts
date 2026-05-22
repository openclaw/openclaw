import { i as OpenClawConfig } from "../types.openclaw-BMMD0Ykw.js";
import { t as PluginMetadataRegistryView } from "../plugin-metadata-snapshot.types-LoO9MWu2.js";
import { rn as ProviderPlugin } from "../types-Dd0yIOXW2.js";

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