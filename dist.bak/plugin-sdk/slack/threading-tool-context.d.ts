import type { ChannelThreadingContext, ChannelThreadingToolContext } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
export declare function buildSlackThreadingToolContext(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    context: ChannelThreadingContext;
    hasRepliedRef?: {
        value: boolean;
    };
}): ChannelThreadingToolContext;
