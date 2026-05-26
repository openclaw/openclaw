import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import { type PluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import type { PluginRegistrySnapshot } from "./plugin-registry-snapshot.js";
export type GatewayStartupPluginPlan = {
    channelPluginIds: readonly string[];
    configuredDeferredChannelPluginIds: readonly string[];
    pluginIds: readonly string[];
};
export declare function resolveChannelPluginIds(params: {
    config: OpenClawConfig;
    workspaceDir?: string;
    env: NodeJS.ProcessEnv;
}): string[];
export declare function resolveChannelPluginIdsFromRegistry(params: {
    manifestRegistry: PluginManifestRegistry;
}): string[];
export declare function resolveConfiguredDeferredChannelPluginIdsFromRegistry(params: {
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    index: PluginRegistrySnapshot;
    manifestRegistry: PluginManifestRegistry;
}): string[];
export declare function resolveConfiguredDeferredChannelPluginIds(params: {
    config: OpenClawConfig;
    workspaceDir?: string;
    env: NodeJS.ProcessEnv;
}): string[];
export declare function resolveGatewayStartupPluginPlanFromRegistry(params: {
    config: OpenClawConfig;
    activationSourceConfig?: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    index: PluginRegistrySnapshot;
    manifestRegistry: PluginManifestRegistry;
    platform?: NodeJS.Platform;
}): GatewayStartupPluginPlan;
export declare function resolveGatewayStartupPluginIdsFromRegistry(params: {
    config: OpenClawConfig;
    activationSourceConfig?: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    index: PluginRegistrySnapshot;
    manifestRegistry: PluginManifestRegistry;
    platform?: NodeJS.Platform;
}): string[];
export declare function loadGatewayStartupPluginPlan(params: {
    config: OpenClawConfig;
    activationSourceConfig?: OpenClawConfig;
    workspaceDir?: string;
    env: NodeJS.ProcessEnv;
    index?: PluginRegistrySnapshot;
    metadataSnapshot?: PluginMetadataSnapshot;
    platform?: NodeJS.Platform;
}): GatewayStartupPluginPlan;
export declare function resolveGatewayStartupPluginIds(params: {
    config: OpenClawConfig;
    activationSourceConfig?: OpenClawConfig;
    workspaceDir?: string;
    env: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
}): string[];
