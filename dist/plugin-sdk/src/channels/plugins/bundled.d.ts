import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { BundledChannelLegacySessionSurface, BundledChannelLegacyStateMigrationDetector, BundledEntryModuleLoadOptions } from "../../plugin-sdk/channel-entry-contract.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";
type BundledChannelEntryRuntimeContract = {
    kind: "bundled-channel-entry";
    id: string;
    name: string;
    description: string;
    features?: {
        accountInspect?: boolean;
    };
    register: (api: unknown) => void;
    loadChannelPlugin: (options?: BundledEntryModuleLoadOptions) => ChannelPlugin;
    loadChannelSecrets?: (options?: BundledEntryModuleLoadOptions) => ChannelPlugin["secrets"] | undefined;
    loadChannelAccountInspector?: (options?: BundledEntryModuleLoadOptions) => NonNullable<ChannelPlugin["config"]["inspectAccount"]>;
    setChannelRuntime?: (runtime: PluginRuntime) => void;
};
type BundledChannelSetupEntryRuntimeContract = {
    kind: "bundled-channel-setup-entry";
    loadSetupPlugin: (options?: BundledEntryModuleLoadOptions) => ChannelPlugin;
    loadSetupSecrets?: (options?: BundledEntryModuleLoadOptions) => ChannelPlugin["secrets"] | undefined;
    loadLegacyStateMigrationDetector?: (options?: BundledEntryModuleLoadOptions) => BundledChannelLegacyStateMigrationDetector;
    loadLegacySessionSurface?: (options?: BundledEntryModuleLoadOptions) => BundledChannelLegacySessionSurface;
    features?: {
        legacyStateMigrations?: boolean;
        legacySessionSurfaces?: boolean;
    };
};
type BundledChannelPackageSetupFeature = "configPromotion" | "legacyStateMigrations" | "legacySessionSurfaces";
export declare function listBundledChannelPluginIds(): readonly ChannelId[];
export declare function hasBundledChannelPackageSetupFeature(id: ChannelId, feature: BundledChannelPackageSetupFeature): boolean;
export declare function listBundledChannelPlugins(): readonly ChannelPlugin[];
export declare function listBundledChannelSetupPlugins(): readonly ChannelPlugin[];
export declare function listBundledChannelSetupPluginsByFeature(feature: keyof NonNullable<BundledChannelSetupEntryRuntimeContract["features"]>, options?: {
    config?: OpenClawConfig;
}): readonly ChannelPlugin[];
export declare function listBundledChannelLegacySessionSurfaces(options?: {
    config?: OpenClawConfig;
}): readonly BundledChannelLegacySessionSurface[];
export declare function listBundledChannelLegacyStateMigrationDetectors(options?: {
    config?: OpenClawConfig;
}): readonly BundledChannelLegacyStateMigrationDetector[];
export declare function hasBundledChannelEntryFeature(id: ChannelId, feature: keyof NonNullable<BundledChannelEntryRuntimeContract["features"]>): boolean;
export declare function getBundledChannelAccountInspector(id: ChannelId): NonNullable<ChannelPlugin["config"]["inspectAccount"]> | undefined;
export declare function getBundledChannelPlugin(id: ChannelId): ChannelPlugin | undefined;
export declare function getBundledChannelSecrets(id: ChannelId): ChannelPlugin["secrets"] | undefined;
export declare function getBundledChannelSetupPlugin(id: ChannelId, env?: NodeJS.ProcessEnv): ChannelPlugin | undefined;
export declare function getBundledChannelSetupSecrets(id: ChannelId, env?: NodeJS.ProcessEnv): ChannelPlugin["secrets"] | undefined;
export declare function requireBundledChannelPlugin(id: ChannelId): ChannelPlugin;
export declare function setBundledChannelRuntime(id: ChannelId, runtime: PluginRuntime): void;
export {};
