import { type AgentComponentContext, type AgentComponentInteraction, type ComponentInteractionContext, type DiscordChannelContext } from "./agent-components-helpers.js";
import { resolveDiscordGuildEntry } from "./allow-list.js";
export declare function resolveDiscordComponentOriginatingTo(interactionCtx: Pick<ComponentInteractionContext, "isDirectMessage" | "userId" | "channelId">): string | undefined;
export declare function dispatchDiscordComponentEvent(params: {
    ctx: AgentComponentContext;
    interaction: AgentComponentInteraction;
    interactionCtx: ComponentInteractionContext;
    channelCtx: DiscordChannelContext;
    guildInfo: ReturnType<typeof resolveDiscordGuildEntry>;
    eventText: string;
    replyToId?: string;
    routeOverrides?: {
        sessionKey?: string;
        agentId?: string;
        accountId?: string;
    };
}): Promise<void>;
