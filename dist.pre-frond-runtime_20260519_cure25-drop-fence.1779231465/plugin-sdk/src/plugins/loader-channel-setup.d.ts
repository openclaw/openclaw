import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime } from "./runtime/types.js";
export declare function mergeSetupRuntimeChannelPlugin(runtimePlugin: ChannelPlugin, setupPlugin: ChannelPlugin): ChannelPlugin;
export type BundledRuntimeChannelRegistration = {
    id?: string;
    loadChannelPlugin?: () => ChannelPlugin;
    loadChannelSecrets?: () => ChannelPlugin["secrets"] | undefined;
    setChannelRuntime?: (runtime: PluginRuntime) => void;
};
export declare function resolveBundledRuntimeChannelRegistration(moduleExport: unknown): BundledRuntimeChannelRegistration;
export declare function loadBundledRuntimeChannelPlugin(params: {
    registration: BundledRuntimeChannelRegistration;
}): {
    plugin?: ChannelPlugin;
    loadError?: unknown;
};
export declare function resolveSetupChannelRegistration(moduleExport: unknown): {
    plugin?: ChannelPlugin;
    setChannelRuntime?: (runtime: PluginRuntime) => void;
    usesBundledSetupContract?: boolean;
    loadError?: unknown;
};
export declare function shouldLoadChannelPluginInSetupRuntime(params: {
    manifestChannels: string[];
    setupSource?: string;
    startupDeferConfiguredChannelFullLoadUntilAfterListen?: boolean;
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    preferSetupRuntimeForChannelPlugins?: boolean;
}): boolean;
export declare function channelPluginIdBelongsToManifest(params: {
    channelId: string | undefined;
    pluginId: string;
    manifestChannels: readonly string[];
}): boolean;
