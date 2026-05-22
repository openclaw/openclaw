import { ChannelType } from "../internal/discord.js";
import { type DiscordChannelInfo, type DiscordChannelInfoClient } from "./message-utils.js";
type DiscordThreadLikeChannelContext = {
    channelType?: ChannelType;
    isThreadChannel: boolean;
    channelId: string;
    channelName?: string;
    channelSlug: string;
    parentId?: string;
    threadParentId?: string;
    threadParentName?: string;
    threadParentSlug: string;
    channelInfo: DiscordChannelInfo | null;
};
export declare function resolveDiscordThreadLikeChannelContext(params: {
    client: DiscordChannelInfoClient;
    channel: unknown;
    channelIdFallback?: string;
    channelInfo?: DiscordChannelInfo | null;
}): Promise<DiscordThreadLikeChannelContext>;
export declare function resolveFetchedDiscordThreadLikeChannelContext(params: {
    client: DiscordChannelInfoClient;
    channel: unknown;
    channelIdFallback?: string;
}): Promise<DiscordThreadLikeChannelContext>;
export {};
