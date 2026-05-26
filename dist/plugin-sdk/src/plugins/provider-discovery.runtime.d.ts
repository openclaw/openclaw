import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataRegistryView } from "./plugin-metadata-snapshot.types.js";
import type { ProviderPlugin } from "./types.js";
export declare function resolvePluginDiscoveryProvidersRuntime(params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    onlyPluginIds?: string[];
    includeUntrustedWorkspacePlugins?: boolean;
    requireCompleteDiscoveryEntryCoverage?: boolean;
    discoveryEntriesOnly?: boolean;
    pluginMetadataSnapshot?: PluginMetadataRegistryView;
}): ProviderPlugin[];
