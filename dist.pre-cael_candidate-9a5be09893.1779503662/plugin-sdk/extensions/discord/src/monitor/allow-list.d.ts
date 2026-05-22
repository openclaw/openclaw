import type { AllowlistMatch } from "openclaw/plugin-sdk/allow-from";
import { type ChannelMatchSource } from "openclaw/plugin-sdk/channel-targets";
import type { Guild, User } from "../internal/discord.js";
export type DiscordAllowList = {
    allowAll: boolean;
    ids: Set<string>;
    names: Set<string>;
};
type DiscordAllowListMatch = AllowlistMatch<"wildcard" | "id" | "name" | "tag">;
type DiscordChannelOverrideConfig = {
    requireMention?: boolean;
    ignoreOtherMentions?: boolean;
    skills?: string[];
    enabled?: boolean;
    users?: string[];
    roles?: string[];
    systemPrompt?: string;
    includeThreadStarter?: boolean;
    autoThread?: boolean;
    autoThreadName?: "message" | "generated";
    autoArchiveDuration?: "60" | "1440" | "4320" | "10080" | 60 | 1440 | 4320 | 10080;
};
export type DiscordGuildEntryResolved = {
    id?: string;
    slug?: string;
    requireMention?: boolean;
    ignoreOtherMentions?: boolean;
    reactionNotifications?: "off" | "own" | "all" | "allowlist";
    users?: string[];
    roles?: string[];
    channels?: Record<string, DiscordChannelOverrideConfig>;
};
export type DiscordChannelConfigResolved = DiscordChannelOverrideConfig & {
    allowed: boolean;
    matchKey?: string;
    matchSource?: ChannelMatchSource;
};
export declare function normalizeDiscordAllowList(raw: string[] | undefined, prefixes: string[]): {
    allowAll: boolean;
    ids: Set<string>;
    names: Set<string>;
} | null;
export declare function normalizeDiscordSlug(value: string): string;
export declare function normalizeDiscordDisplaySlug(value: string): string;
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
export declare function resolveDiscordOwnerAccess(params: {
    allowFrom?: string[];
    sender: {
        id: string;
        name?: string;
        tag?: string;
    };
    allowNameMatching?: boolean;
}): {
    ownerAllowList: DiscordAllowList | null;
    ownerAllowed: boolean;
};
export declare function resolveDiscordCommandAuthorized(params: {
    isDirectMessage: boolean;
    allowFrom?: string[];
    guildInfo?: DiscordGuildEntryResolved | null;
    author: User;
    allowNameMatching?: boolean;
}): boolean;
export declare function resolveDiscordGuildEntry(params: {
    guild?: Guild<true> | Guild | null;
    guildId?: string | null;
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
export declare function isDiscordGroupAllowedByPolicy(params: {
    groupPolicy: "open" | "disabled" | "allowlist";
    guildAllowlisted: boolean;
    channelAllowlistConfigured: boolean;
    channelAllowed: boolean;
}): boolean;
export declare function resolveDiscordChannelPolicyCommandAuthorizer(params: {
    groupPolicy: "open" | "disabled" | "allowlist";
    guildInfo?: DiscordGuildEntryResolved | null;
    channelConfig?: DiscordChannelConfigResolved | null;
}): {
    readonly configured: boolean;
    readonly allowed: boolean;
};
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
    channelConfig?: DiscordChannelConfigResolved | null;
    guildInfo?: DiscordGuildEntryResolved | null;
    memberRoleIds?: string[];
    allowlist?: string[];
    allowNameMatching?: boolean;
}): boolean;
export {};
