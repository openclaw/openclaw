import type { ChannelAgentTool, ChannelMessageActionName } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
/**
 * Get the list of supported message actions for a specific channel.
 * Returns an empty array if channel is not found or has no actions configured.
 */
export declare function listChannelSupportedActions(params: {
    cfg?: OpenClawConfig;
    channel?: string;
}): ChannelMessageActionName[];
/**
 * Get the list of all supported message actions across all configured channels.
 */
export declare function listAllChannelSupportedActions(params: {
    cfg?: OpenClawConfig;
}): ChannelMessageActionName[];
export declare function listChannelAgentTools(params: {
    cfg?: OpenClawConfig;
}): ChannelAgentTool[];
export declare function resolveChannelMessageToolHints(params: {
    cfg?: OpenClawConfig;
    channel?: string | null;
    accountId?: string | null;
}): string[];
export declare const __testing: {
    resetLoggedListActionErrors(): void;
};
