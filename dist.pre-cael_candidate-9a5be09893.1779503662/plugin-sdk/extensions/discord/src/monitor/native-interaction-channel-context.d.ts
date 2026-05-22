import { ChannelType } from "../internal/discord.js";
import type { DiscordChannelInfoClient } from "./message-utils.js";
type DiscordInteractionChannel = {
    id?: string;
    type?: ChannelType;
};
type DiscordNativeInteractionChannelContext = {
    channelType?: ChannelType;
    isDirectMessage: boolean;
    isGroupDm: boolean;
    isThreadChannel: boolean;
    channelName?: string;
    channelSlug: string;
    rawChannelId: string;
    threadParentId?: string;
    threadParentName?: string;
    threadParentSlug: string;
};
export declare function resolveDiscordNativeInteractionChannelContext(params: {
    channel: DiscordInteractionChannel | null | undefined;
    client: DiscordChannelInfoClient;
    hasGuild: boolean;
    channelIdFallback: string;
}): Promise<DiscordNativeInteractionChannelContext>;
export {};
