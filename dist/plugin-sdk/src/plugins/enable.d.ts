import type { OpenClawConfig } from "../config/types.openclaw.js";
export type PluginEnableResult = {
    config: OpenClawConfig;
    enabled: boolean;
    pluginId: string;
    reason?: string;
};
export declare function enablePluginInConfig(cfg: OpenClawConfig, pluginId: string, options?: {
    updateChannelConfig?: boolean;
}): PluginEnableResult;
