import type { ActivePluginChannelRegistry } from "./channel-registry-state.types.js";
export declare const PLUGIN_REGISTRY_STATE: unique symbol;
export declare function getActivePluginChannelRegistryFromState(): ActivePluginChannelRegistry | null;
export declare function getActivePluginChannelRegistryVersionFromState(): number;
