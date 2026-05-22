import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type DeliverableMessageChannel } from "../../utils/message-channel.js";
export declare function resetOutboundChannelResolutionStateForTest(): void;
export declare function normalizeDeliverableOutboundChannel(raw?: string | null): DeliverableMessageChannel | undefined;
export declare function resolveOutboundChannelPlugin(params: {
    channel: string;
    cfg?: OpenClawConfig;
}): ChannelPlugin | undefined;
