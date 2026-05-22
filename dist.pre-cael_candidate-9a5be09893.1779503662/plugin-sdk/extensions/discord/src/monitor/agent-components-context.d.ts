import { type AgentComponentContext, type AgentComponentInteraction, type ComponentInteractionContext, type DiscordChannelContext } from "./agent-components.types.js";
export declare function resolveAgentComponentRoute(params: {
    ctx: AgentComponentContext;
    rawGuildId: string | undefined;
    memberRoleIds: string[];
    isDirectMessage: boolean;
    isGroupDm: boolean;
    userId: string;
    channelId: string;
    parentId: string | undefined;
}): import("openclaw/plugin-sdk/routing").ResolvedAgentRoute;
export declare function ackComponentInteraction(params: {
    interaction: AgentComponentInteraction;
    replyOpts: {
        ephemeral?: boolean;
    };
    label: string;
}): Promise<void>;
export declare function resolveDiscordChannelContext(interaction: AgentComponentInteraction): DiscordChannelContext;
export declare function resolveComponentInteractionContext(params: {
    interaction: AgentComponentInteraction;
    label: string;
    defer?: boolean;
}): Promise<ComponentInteractionContext | null>;
