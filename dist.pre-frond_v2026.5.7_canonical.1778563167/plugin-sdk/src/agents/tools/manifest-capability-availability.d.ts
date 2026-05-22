import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
export type CapabilityContractKey = "imageGenerationProviders" | "videoGenerationProviders" | "musicGenerationProviders" | "mediaUnderstandingProviders";
export declare function getCurrentCapabilityMetadataSnapshot(params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
}): PluginMetadataSnapshot | undefined;
export declare function loadCapabilityMetadataSnapshot(params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): Pick<PluginMetadataSnapshot, "index" | "plugins">;
export declare function hasSnapshotCapabilityAvailability(params: {
    snapshot: Pick<PluginMetadataSnapshot, "index" | "plugins">;
    key: CapabilityContractKey;
    config?: OpenClawConfig;
    authStore?: AuthProfileStore;
}): boolean;
export declare function hasSnapshotProviderEnvAvailability(params: {
    snapshot: Pick<PluginMetadataSnapshot, "index" | "plugins">;
    providerId: string;
    config?: OpenClawConfig;
}): boolean;
