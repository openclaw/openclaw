import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { AutocompleteInteraction } from "../internal/discord.js";
import { resolveDiscordChannelConfigWithFallback, resolveDiscordGuildEntry } from "./allow-list.js";
import type { DiscordConfig } from "./native-command.types.js";
export declare function resolveDiscordNativeCommandAllowlistAccess(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    sender: {
        id: string;
        name?: string;
        tag?: string;
    };
    chatType: "direct" | "group" | "thread" | "channel";
    conversationId?: string;
    guildId?: string | null;
}): {
    readonly configured: false;
    readonly allowed: false;
} | {
    readonly configured: true;
    readonly allowed: boolean;
};
export declare function resolveDiscordGuildNativeCommandAuthorized(params: {
    cfg: OpenClawConfig;
    accountId: string;
    discordConfig: DiscordConfig;
    useAccessGroups: boolean;
    commandsAllowFromAccess: ReturnType<typeof resolveDiscordNativeCommandAllowlistAccess>;
    guildInfo?: ReturnType<typeof resolveDiscordGuildEntry> | null;
    channelConfig?: ReturnType<typeof resolveDiscordChannelConfigWithFallback> | null;
    memberRoleIds: string[];
    sender: {
        id: string;
        name?: string;
        tag?: string;
    };
    allowNameMatching: boolean;
    ownerAllowListConfigured: boolean;
    ownerAllowed: boolean;
}): Promise<boolean>;
export declare function resolveDiscordNativeGroupDmAccess(params: {
    isGroupDm: boolean;
    groupEnabled?: boolean;
    groupChannels?: string[];
    channelId: string;
    channelName?: string;
    channelSlug: string;
}): {
    allowed: true;
} | {
    allowed: false;
    reason: "disabled" | "not-allowlisted";
};
export declare function resolveDiscordNativeAutocompleteAuthorized(params: {
    interaction: AutocompleteInteraction;
    cfg: OpenClawConfig;
    discordConfig: DiscordConfig;
    accountId: string;
}): Promise<boolean>;
