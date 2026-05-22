import type { ChannelType, Message } from "../internal/discord.js";
export type DiscordChannelInfo = {
    type: ChannelType;
    name?: string;
    topic?: string;
    parentId?: string;
    ownerId?: string;
};
export type DiscordChannelInfoClient = {
    fetchChannel(channelId: string): Promise<unknown>;
};
export declare function resetDiscordChannelInfoCacheForTest(): void;
export declare function resolveDiscordMessageChannelId(params: {
    message: Message;
    eventChannelId?: string | number | null;
}): string;
export declare function resolveDiscordChannelInfo(client: DiscordChannelInfoClient, channelId: string): Promise<DiscordChannelInfo | null>;
