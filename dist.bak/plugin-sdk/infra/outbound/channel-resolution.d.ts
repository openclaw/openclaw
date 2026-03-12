import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { type DeliverableMessageChannel } from "../../utils/message-channel.js";
export declare function normalizeDeliverableOutboundChannel(raw?: string | null): DeliverableMessageChannel | undefined;
export declare function resolveOutboundChannelPlugin(params: {
    channel: string;
    cfg?: OpenClawConfig;
}): ChannelPlugin | undefined;
