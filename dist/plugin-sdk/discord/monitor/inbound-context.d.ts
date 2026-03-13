import { type DiscordChannelConfigResolved, type DiscordGuildEntryResolved } from "./allow-list.js";
export declare function buildDiscordGroupSystemPrompt(channelConfig?: DiscordChannelConfigResolved | null): string | undefined;
export declare function buildDiscordUntrustedContext(params: {
    isGuild: boolean;
    channelTopic?: string;
}): string[] | undefined;
export declare function buildDiscordInboundAccessContext(params: {
    channelConfig?: DiscordChannelConfigResolved | null;
    guildInfo?: DiscordGuildEntryResolved | null;
    sender: {
        id: string;
        name?: string;
        tag?: string;
    };
    allowNameMatching?: boolean;
    isGuild: boolean;
    channelTopic?: string;
}): {
    groupSystemPrompt: string | undefined;
    untrustedContext: string[] | undefined;
    ownerAllowFrom: string[] | undefined;
};
