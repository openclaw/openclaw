import type { DiscordChannelConfigResolved } from "./allow-list.js";
export declare function logDiscordPreflightChannelConfig(params: {
    channelConfig: DiscordChannelConfigResolved | null;
    channelMatchMeta: string;
    channelId: string;
}): void;
export declare function logDiscordPreflightInboundSummary(params: {
    messageId: string;
    guildId?: string;
    channelId: string;
    wasMentioned: boolean;
    isDirectMessage: boolean;
    isGroupDm: boolean;
    hasContent: boolean;
}): void;
