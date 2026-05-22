import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "./config-state.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
type OwnerPlugin = Pick<PluginManifestRecord, "id" | "origin" | "enabledByDefault" | "enabledByDefaultOnPlatforms">;
type NormalizedPluginsConfig = ReturnType<typeof normalizePluginsConfig>;
export type ManifestOwnerBasePolicyBlockReason = "plugins-disabled" | "blocked-by-denylist" | "plugin-disabled" | "not-in-allowlist";
export declare function isBundledManifestOwner(plugin: Pick<PluginManifestRecord, "origin">): boolean;
export declare function hasExplicitManifestOwnerTrust(params: {
    plugin: Pick<PluginManifestRecord, "id">;
    normalizedConfig: NormalizedPluginsConfig;
}): boolean;
export declare function passesManifestOwnerBasePolicy(params: {
    plugin: Pick<PluginManifestRecord, "id">;
    normalizedConfig: NormalizedPluginsConfig;
    allowExplicitlyDisabled?: boolean;
    allowRestrictiveAllowlistBypass?: boolean;
}): boolean;
export declare function resolveManifestOwnerBasePolicyBlock(params: {
    plugin: Pick<PluginManifestRecord, "id">;
    normalizedConfig: NormalizedPluginsConfig;
    allowExplicitlyDisabled?: boolean;
    allowRestrictiveAllowlistBypass?: boolean;
}): ManifestOwnerBasePolicyBlockReason | null;
export declare function isActivatedManifestOwner(params: {
    plugin: OwnerPlugin;
    normalizedConfig: NormalizedPluginsConfig;
    rootConfig?: OpenClawConfig;
}): boolean;
export {};
