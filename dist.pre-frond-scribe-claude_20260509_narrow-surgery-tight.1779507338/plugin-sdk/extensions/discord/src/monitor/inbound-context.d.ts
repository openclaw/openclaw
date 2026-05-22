import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { type DiscordChannelConfigResolved, type DiscordGuildEntryResolved } from "./allow-list.js";
type DiscordSupplementalContextSender = {
    id?: string;
    name?: string;
    tag?: string;
    memberRoleIds?: string[];
};
export declare function createDiscordSupplementalContextAccessChecker(params: {
    channelConfig?: DiscordChannelConfigResolved | null;
    guildInfo?: DiscordGuildEntryResolved | null;
    allowNameMatching?: boolean;
    isGuild: boolean;
}): (sender: DiscordSupplementalContextSender) => boolean;
export declare function buildDiscordGroupSystemPrompt(channelConfig?: DiscordChannelConfigResolved | null): string | undefined;
export declare function buildDiscordUntrustedContext(params: {
    isGuild: boolean;
    channelTopic?: string;
}): MsgContext["UntrustedStructuredContext"] | undefined;
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
    untrustedContext: {
        label: string;
        source?: string;
        type?: string;
        payload: unknown;
    }[] | undefined;
    ownerAllowFrom: string[] | undefined;
};
export {};
