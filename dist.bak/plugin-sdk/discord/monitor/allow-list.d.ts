import type { Guild, User } from "@buape/carbon";
import type { AllowlistMatch } from "../../channels/allowlist-match.js";
import { type ChannelMatchSource } from "../../channels/channel-config.js";
export type DiscordAllowList = {
    allowAll: boolean;
    ids: Set<string>;
    names: Set<string>;
};
export type DiscordAllowListMatch = AllowlistMatch<"wildcard" | "id" | "name" | "tag">;
export type DiscordGuildEntryResolved = {
    id?: string;
    slug?: string;
    requireMention?: boolean;
    reactionNotifications?: "off" | "own" | "all" | "allowlist";
    users?: string[];
    roles?: string[];
    channels?: Record<string, {
        allow?: boolean;
        requireMention?: boolean;
        skills?: string[];
        enabled?: boolean;
        users?: string[];
        roles?: string[];
        systemPrompt?: string;
        includeThreadStarter?: boolean;
        autoThread?: boolean;
    }>;
};
export type DiscordChannelConfigResolved = {
    allowed: boolean;
    requireMention?: boolean;
    skills?: string[];
    enabled?: boolean;
    users?: string[];
    roles?: string[];
    systemPrompt?: string;
    includeThreadStarter?: boolean;
    autoThread?: boolean;
    matchKey?: string;
    matchSource?: ChannelMatchSource;
};
export declare function normalizeDiscordAllowList(raw: string[] | undefined, prefixes: string[]): {
    allowAll: boolean;
    ids: Set<string>;
    names: Set<string>;
} | null;
export declare function normalizeDiscordSlug(value: string): string;
export declare function allowListMatches(list: DiscordAllowList, candidate: {
    id?: string;
    name?: string;
    tag?: string;
}, params?: {
    allowNameMatching?: boolean;
}): boolean;
export declare function resolveDiscordAllowListMatch(params: {
    allowList: DiscordAllowList;
    candidate: {
        id?: string;
        name?: string;
        tag?: string;
    };
    allowNameMatching?: boolean;
}): DiscordAllowListMatch;
export declare function resolveDiscordUserAllowed(params: {
    allowList?: string[];
    userId: string;
    userName?: string;
    userTag?: string;
    allowNameMatching?: boolean;
}): boolean;
export declare function resolveDiscordRoleAllowed(params: {
    allowList?: string[];
    memberRoleIds: string[];
}): boolean;
export declare function resolveDiscordMemberAllowed(params: {
    userAllowList?: string[];
    roleAllowList?: string[];
    memberRoleIds: string[];
    userId: string;
    userName?: string;
    userTag?: string;
    allowNameMatching?: boolean;
}): boolean;
export declare function resolveDiscordMemberAccessState(params: {
    channelConfig?: DiscordChannelConfigResolved | null;
    guildInfo?: DiscordGuildEntryResolved | null;
    memberRoleIds: string[];
    sender: {
        id: string;
        name?: string;
        tag?: string;
    };
    allowNameMatching?: boolean;
}): {
    readonly channelUsers: string[] | undefined;
    readonly channelRoles: string[] | undefined;
    readonly hasAccessRestrictions: boolean;
    readonly memberAllowed: boolean;
};
export declare function resolveDiscordOwnerAllowFrom(params: {
    channelConfig?: DiscordChannelConfigResolved | null;
    guildInfo?: DiscordGuildEntryResolved | null;
    sender: {
        id: string;
        name?: string;
        tag?: string;
    };
    allowNameMatching?: boolean;
}): string[] | undefined;
export declare function resolveDiscordCommandAuthorized(params: {
    isDirectMessage: boolean;
    allowFrom?: string[];
    guildInfo?: DiscordGuildEntryResolved | null;
    author: User;
    allowNameMatching?: boolean;
}): boolean;
export declare function resolveDiscordGuildEntry(params: {
    guild?: Guild<true> | Guild | null;
    guildEntries?: Record<string, DiscordGuildEntryResolved>;
}): DiscordGuildEntryResolved | null;
type DiscordChannelScope = "channel" | "thread";
export declare function resolveDiscordChannelConfig(params: {
    guildInfo?: DiscordGuildEntryResolved | null;
    channelId: string;
    channelName?: string;
    channelSlug: string;
}): DiscordChannelConfigResolved | null;
export declare function resolveDiscordChannelConfigWithFallback(params: {
    guildInfo?: DiscordGuildEntryResolved | null;
    channelId: string;
    channelName?: string;
    channelSlug: string;
    parentId?: string;
    parentName?: string;
    parentSlug?: string;
    scope?: DiscordChannelScope;
}): DiscordChannelConfigResolved | null;
export declare function resolveDiscordShouldRequireMention(params: {
    isGuildMessage: boolean;
    isThread: boolean;
    botId?: string | null;
    threadOwnerId?: string | null;
    channelConfig?: DiscordChannelConfigResolved | null;
    guildInfo?: DiscordGuildEntryResolved | null;
    /** Pass pre-computed value to avoid redundant checks. */
    isAutoThreadOwnedByBot?: boolean;
}): boolean;
export declare function isDiscordAutoThreadOwnedByBot(params: {
    isThread: boolean;
    channelConfig?: DiscordChannelConfigResolved | null;
    botId?: string | null;
    threadOwnerId?: string | null;
}): boolean;
export declare function isDiscordGroupAllowedByPolicy(params: {
    groupPolicy: "open" | "disabled" | "allowlist";
    guildAllowlisted: boolean;
    channelAllowlistConfigured: boolean;
    channelAllowed: boolean;
}): boolean;
export declare function resolveGroupDmAllow(params: {
    channels?: string[];
    channelId: string;
    channelName?: string;
    channelSlug: string;
}): boolean;
export declare function shouldEmitDiscordReactionNotification(params: {
    mode?: "off" | "own" | "all" | "allowlist";
    botId?: string;
    messageAuthorId?: string;
    userId: string;
    userName?: string;
    userTag?: string;
    allowlist?: string[];
    allowNameMatching?: boolean;
}): boolean;
export {};
