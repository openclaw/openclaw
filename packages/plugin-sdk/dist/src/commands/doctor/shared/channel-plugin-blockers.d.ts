import type { OpenClawConfig } from "../../../config/types.openclaw.js";
export type ChannelPluginBlockerHit = {
    channelId: string;
    pluginId: string;
    reason: "disabled in config" | "plugins disabled";
};
export declare function scanConfiguredChannelPluginBlockers(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): ChannelPluginBlockerHit[];
export declare function collectConfiguredChannelPluginBlockerWarnings(hits: ChannelPluginBlockerHit[]): string[];
export declare function isWarningBlockedByChannelPlugin(warning: string, hits: ChannelPluginBlockerHit[]): boolean;
