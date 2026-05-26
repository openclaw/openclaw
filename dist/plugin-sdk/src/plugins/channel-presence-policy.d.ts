import { type ChannelPresenceSignalSource } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
export type ConfiguredChannelPresenceSource = "explicit-config" | Exclude<ChannelPresenceSignalSource, "config"> | "manifest-env";
export type ConfiguredChannelBlockedReason = "plugins-disabled" | "blocked-by-denylist" | "plugin-disabled" | "not-in-allowlist" | "workspace-disabled-by-default" | "bundled-disabled-by-default" | "untrusted-plugin" | "no-channel-owner" | "not-activated";
export type ConfiguredChannelPresencePolicyEntry = {
    channelId: string;
    sources: ConfiguredChannelPresenceSource[];
    effective: boolean;
    pluginIds: string[];
    blockedReasons: ConfiguredChannelBlockedReason[];
};
export declare function hasExplicitChannelConfig(params: {
    config: OpenClawConfig;
    channelId: string;
}): boolean;
export declare function listExplicitConfiguredChannelIdsForConfig(config: OpenClawConfig): string[];
export declare function resolveConfiguredChannelPresencePolicy(params: {
    config: OpenClawConfig;
    activationSourceConfig?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    includePersistedAuthState?: boolean;
    manifestRecords?: readonly PluginManifestRecord[];
}): ConfiguredChannelPresencePolicyEntry[];
export declare function listConfiguredChannelIdsForReadOnlyScope(params: Parameters<typeof resolveConfiguredChannelPresencePolicy>[0]): string[];
export declare function hasConfiguredChannelsForReadOnlyScope(params: Parameters<typeof resolveConfiguredChannelPresencePolicy>[0]): boolean;
export declare function listConfiguredAnnounceChannelIdsForConfig(params: {
    config: OpenClawConfig;
    activationSourceConfig?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): string[];
export declare function resolveDiscoverableScopedChannelPluginIds(params: {
    config: OpenClawConfig;
    activationSourceConfig?: OpenClawConfig;
    channelIds: readonly string[];
    workspaceDir?: string;
    env: NodeJS.ProcessEnv;
    manifestRecords?: readonly PluginManifestRecord[];
}): string[];
export declare function resolveConfiguredChannelPluginIds(params: {
    config: OpenClawConfig;
    activationSourceConfig?: OpenClawConfig;
    workspaceDir?: string;
    env: NodeJS.ProcessEnv;
}): string[];
