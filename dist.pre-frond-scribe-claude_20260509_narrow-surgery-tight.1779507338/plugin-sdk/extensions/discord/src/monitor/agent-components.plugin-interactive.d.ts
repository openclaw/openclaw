import { type AgentComponentContext, type AgentComponentInteraction, type ComponentInteractionContext, type DiscordChannelContext } from "./agent-components-helpers.js";
export declare function dispatchPluginDiscordInteractiveEvent(params: {
    ctx: AgentComponentContext;
    interaction: AgentComponentInteraction;
    interactionCtx: ComponentInteractionContext;
    channelCtx: DiscordChannelContext;
    isAuthorizedSender: boolean;
    data: string;
    kind: "button" | "select" | "modal";
    values?: string[];
    fields?: Array<{
        id: string;
        name: string;
        values: string[];
    }>;
    messageId?: string;
}): Promise<"handled" | "unmatched">;
