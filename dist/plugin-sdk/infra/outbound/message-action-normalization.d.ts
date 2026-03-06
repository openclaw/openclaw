import type { ChannelMessageActionName, ChannelThreadingToolContext } from "../../channels/plugins/types.js";
export declare function normalizeMessageActionInput(params: {
    action: ChannelMessageActionName;
    args: Record<string, unknown>;
    toolContext?: ChannelThreadingToolContext;
}): Record<string, unknown>;
