import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function setPluginEnabledInConfig(config: OpenClawConfig, pluginId: string, enabled: boolean, options?: {
    updateChannelConfig?: boolean;
}): OpenClawConfig;
