import type { OpenClawConfig } from "../../config/config.js";
import { type DeliverableMessageChannel } from "../../utils/message-channel.js";
export type MessageChannelId = DeliverableMessageChannel;
export type MessageChannelSelectionSource = "explicit" | "tool-context-fallback" | "single-configured";
export declare function listConfiguredMessageChannels(cfg: OpenClawConfig): Promise<MessageChannelId[]>;
export declare function resolveMessageChannelSelection(params: {
    cfg: OpenClawConfig;
    channel?: string | null;
    fallbackChannel?: string | null;
}): Promise<{
    channel: MessageChannelId;
    configured: MessageChannelId[];
    source: MessageChannelSelectionSource;
}>;
