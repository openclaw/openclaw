import { type OpenClawConfig } from "../config/config.js";
export type ChannelSummaryOptions = {
    colorize?: boolean;
    includeAllowFrom?: boolean;
    sourceConfig?: OpenClawConfig;
};
export declare function buildChannelSummary(cfg?: OpenClawConfig, options?: ChannelSummaryOptions): Promise<string[]>;
