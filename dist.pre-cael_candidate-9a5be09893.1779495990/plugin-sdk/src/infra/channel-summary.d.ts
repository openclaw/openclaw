import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export type ChannelSummaryOptions = {
    colorize?: boolean;
    includeAllowFrom?: boolean;
    plugins?: readonly ChannelPlugin[];
    sourceConfig?: OpenClawConfig;
};
export declare function buildChannelSummary(cfg?: OpenClawConfig, options?: ChannelSummaryOptions): Promise<string[]>;
