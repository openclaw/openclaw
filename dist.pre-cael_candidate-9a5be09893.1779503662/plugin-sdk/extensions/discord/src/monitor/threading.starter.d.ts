import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { ChannelType, type Client } from "../internal/discord.js";
import { type DiscordChannelInfo, type DiscordChannelInfoClient } from "./message-utils.js";
import type { DiscordMessageEvent, DiscordReplyDeliveryPlan, DiscordThreadChannel, DiscordThreadParentInfo, DiscordThreadStarter } from "./threading.types.js";
export declare function resolveDiscordThreadChannel(params: {
    isGuildMessage: boolean;
    message: DiscordMessageEvent["message"];
    channelInfo: DiscordChannelInfo | null;
    messageChannelId?: string;
}): DiscordThreadChannel | null;
export declare function resolveDiscordThreadParentInfo(params: {
    client: DiscordChannelInfoClient;
    threadChannel: DiscordThreadChannel;
    channelInfo: DiscordChannelInfo | null;
}): Promise<DiscordThreadParentInfo>;
export declare function resolveDiscordThreadStarter(params: {
    channel: DiscordThreadChannel;
    client: Client;
    parentId?: string;
    parentType?: ChannelType;
    resolveTimestampMs: (value?: string | null) => number | undefined;
}): Promise<DiscordThreadStarter | null>;
export declare function resolveDiscordReplyTarget(opts: {
    replyToMode: ReplyToMode;
    replyToId?: string;
    hasReplied: boolean;
}): string | undefined;
export declare function sanitizeDiscordThreadName(rawName: string, fallbackId: string): string;
export declare function resolveDiscordReplyDeliveryPlan(params: {
    replyTarget: string;
    replyToMode: ReplyToMode;
    messageId: string;
    threadChannel?: DiscordThreadChannel | null;
    createdThreadId?: string | null;
}): DiscordReplyDeliveryPlan;
