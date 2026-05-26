import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveReadOnlyChannelCommandDefaults } from "./read-only-command-defaults.js";
import type { ChannelPlugin } from "./types.plugin.js";
export declare function listPluginLoaderModuleCandidateUrls(importerUrl?: string): URL[];
type ReadOnlyChannelPluginOptions = {
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    workspaceDir?: string;
    activationSourceConfig?: OpenClawConfig;
    includePersistedAuthState?: boolean;
    includeSetupFallbackPlugins?: boolean;
};
type ReadOnlyChannelPluginResolution = {
    plugins: ChannelPlugin[];
    configuredChannelIds: string[];
    missingConfiguredChannelIds: string[];
};
export { resolveReadOnlyChannelCommandDefaults };
export declare function listReadOnlyChannelPluginsForConfig(cfg: OpenClawConfig, options?: ReadOnlyChannelPluginOptions): ChannelPlugin[];
export declare function resolveReadOnlyChannelPluginsForConfig(cfg: OpenClawConfig, options?: ReadOnlyChannelPluginOptions): ReadOnlyChannelPluginResolution;
