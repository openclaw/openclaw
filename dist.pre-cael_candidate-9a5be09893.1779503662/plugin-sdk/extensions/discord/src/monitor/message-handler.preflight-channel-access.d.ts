import { type DiscordChannelConfigResolved, type DiscordGuildEntryResolved } from "./allow-list.js";
export declare function resolveDiscordPreflightChannelAccess(params: {
    isGuildMessage: boolean;
    isGroupDm: boolean;
    groupPolicy: "open" | "disabled" | "allowlist";
    groupDmChannels?: string[];
    messageChannelId: string;
    displayChannelName?: string;
    displayChannelSlug: string;
    guildInfo: DiscordGuildEntryResolved | null;
    channelConfig: DiscordChannelConfigResolved | null;
    channelMatchMeta: string;
}): {
    allowed: boolean;
    channelAllowlistConfigured: boolean;
    channelAllowed: boolean;
};
