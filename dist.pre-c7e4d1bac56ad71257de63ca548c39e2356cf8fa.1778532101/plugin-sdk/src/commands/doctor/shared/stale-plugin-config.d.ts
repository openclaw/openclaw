import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { type PluginSlotKey } from "../../../plugins/slots.js";
type StalePluginSurface = "allow" | "entries" | "slot" | "channel" | "heartbeat" | "modelByChannel";
type StalePluginConfigHit = {
    pluginId: string;
    pathLabel: string;
    surface: StalePluginSurface;
    slotKey?: PluginSlotKey;
};
export declare function isStalePluginAutoRepairBlocked(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): boolean;
export declare function scanStalePluginConfig(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): StalePluginConfigHit[];
export declare function collectStalePluginConfigWarnings(params: {
    hits: StalePluginConfigHit[];
    doctorFixCommand: string;
    autoRepairBlocked?: boolean;
}): string[];
export declare function maybeRepairStalePluginConfig(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): {
    config: OpenClawConfig;
    changes: string[];
};
export {};
