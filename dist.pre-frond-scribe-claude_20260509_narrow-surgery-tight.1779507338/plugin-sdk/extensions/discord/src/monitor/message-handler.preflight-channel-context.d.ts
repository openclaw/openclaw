import { type DiscordGuildEntryResolved } from "./allow-list.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";
export declare function resolveDiscordPreflightChannelContext(params: {
    isGuildMessage: boolean;
    messageChannelId: string;
    channelName?: string;
    guildName?: string;
    guildInfo: DiscordGuildEntryResolved | null;
    threadChannel: DiscordMessagePreflightContext["threadChannel"];
    threadParentId?: string;
    threadParentName?: string;
}): {
    threadName: string | null | undefined;
    configChannelName: string | undefined;
    configChannelSlug: string;
    displayChannelName: string | undefined;
    displayChannelSlug: string;
    guildSlug: string;
    threadChannelSlug: string;
    threadParentSlug: string;
    channelConfig: import("./allow-list.js").DiscordChannelConfigResolved | null;
};
