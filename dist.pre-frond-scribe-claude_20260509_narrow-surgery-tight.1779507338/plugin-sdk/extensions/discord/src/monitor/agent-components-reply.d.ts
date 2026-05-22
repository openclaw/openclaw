import type { AgentComponentInteraction } from "./agent-components.types.js";
export declare function replySilently(interaction: AgentComponentInteraction, params: {
    content: string;
    ephemeral?: boolean;
}): Promise<void>;
