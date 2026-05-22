import type { ActivePluginChannelRegistry } from "./channel-registry-state.types.js";
export declare const PLUGIN_REGISTRY_STATE: unique symbol;
export type ActivePluginChannelRegistrySnapshot = {
    registry: ActivePluginChannelRegistry | null;
    version: number;
};
export declare function getActivePluginChannelRegistrySnapshotFromState(): ActivePluginChannelRegistrySnapshot;
export declare function getActivePluginChannelRegistryFromState(): ActivePluginChannelRegistry | null;
export declare function getActivePluginChannelRegistryVersionFromState(): number;
