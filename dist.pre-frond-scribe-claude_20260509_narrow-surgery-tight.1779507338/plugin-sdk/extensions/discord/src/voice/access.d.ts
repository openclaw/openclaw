import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import type { Guild } from "../internal/discord.js";
import { type DiscordChannelConfigResolved } from "../monitor/allow-list.js";
export declare function authorizeDiscordVoiceIngress(params: {
    cfg: OpenClawConfig;
    discordConfig: DiscordAccountConfig;
    accountId?: string;
    groupPolicy?: "open" | "disabled" | "allowlist";
    useAccessGroups?: boolean;
    guild?: Guild<true> | Guild | null;
    guildName?: string;
    guildId: string;
    channelId: string;
    channelName?: string;
    channelSlug: string;
    parentId?: string;
    parentName?: string;
    parentSlug?: string;
    scope?: "channel" | "thread";
    channelLabel?: string;
    memberRoleIds: string[];
    ownerAllowFrom?: string[];
    sender: {
        id: string;
        name?: string;
        tag?: string;
    };
}): Promise<{
    ok: true;
    channelConfig?: DiscordChannelConfigResolved | null;
} | {
    ok: false;
    message: string;
}>;
