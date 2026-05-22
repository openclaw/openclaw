import type { DiscordComponentEntry } from "../components.js";
import type { AgentComponentContext, AgentComponentInteraction, ComponentInteractionContext, DiscordChannelContext, DiscordUser } from "./agent-components.types.js";
import { resolveDiscordChannelConfigWithFallback, resolveDiscordGuildEntry } from "./allow-list.js";
export declare function ensureComponentUserAllowed(params: {
    entry: DiscordComponentEntry;
    interaction: AgentComponentInteraction;
    user: DiscordUser;
    replyOpts: {
        ephemeral?: boolean;
    };
    componentLabel: string;
    unauthorizedReply: string;
    allowNameMatching: boolean;
}): Promise<boolean>;
export declare function ensureAgentComponentInteractionAllowed(params: {
    ctx: AgentComponentContext;
    interaction: AgentComponentInteraction;
    channelId: string;
    rawGuildId: string | undefined;
    memberRoleIds: string[];
    user: DiscordUser;
    replyOpts: {
        ephemeral?: boolean;
    };
    componentLabel: string;
    unauthorizedReply: string;
}): Promise<{
    parentId: string | undefined;
} | null>;
export declare function resolveAuthorizedComponentInteraction(params: {
    ctx: AgentComponentContext;
    interaction: AgentComponentInteraction;
    label: string;
    componentLabel: string;
    unauthorizedReply: string;
    defer?: boolean;
}): Promise<{
    interactionCtx: ComponentInteractionContext;
    channelCtx: DiscordChannelContext;
    guildInfo: import("./allow-list.js").DiscordGuildEntryResolved | null;
    channelConfig: import("./allow-list.js").DiscordChannelConfigResolved | null;
    allowNameMatching: boolean;
    commandAuthorized: boolean;
    user: import("../internal/structures.ts").User<false>;
    replyOpts: {
        ephemeral?: boolean;
    };
} | null>;
export declare function resolveComponentCommandAuthorized(params: {
    ctx: AgentComponentContext;
    interactionCtx: ComponentInteractionContext;
    channelConfig: ReturnType<typeof resolveDiscordChannelConfigWithFallback>;
    guildInfo: ReturnType<typeof resolveDiscordGuildEntry>;
    allowNameMatching: boolean;
}): Promise<boolean>;
