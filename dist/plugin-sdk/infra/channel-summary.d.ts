import { type OpenClawConfig } from "../config/config.js";
export type ChannelSummaryOptions = {
    colorize?: boolean;
    includeAllowFrom?: boolean;
};
export declare function buildChannelSummary(cfg?: OpenClawConfig, options?: ChannelSummaryOptions): Promise<string[]>;
