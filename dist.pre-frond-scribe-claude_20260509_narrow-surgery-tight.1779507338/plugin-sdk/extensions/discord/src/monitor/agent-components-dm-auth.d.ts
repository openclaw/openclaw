import type { AgentComponentContext, AgentComponentInteraction } from "./agent-components.types.js";
export declare function resolveInteractionContextWithDmAuth(params: {
    ctx: AgentComponentContext;
    interaction: AgentComponentInteraction;
    label: string;
    componentLabel: string;
    defer?: boolean;
}): Promise<import("./agent-components.types.js").ComponentInteractionContext | null>;
