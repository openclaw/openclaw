import type { DiscordComponentEntry, DiscordModalEntry } from "../components.js";
import type { ComponentData, ModalInteraction } from "../internal/discord.js";
import type { AgentComponentInteraction } from "./agent-components.types.js";
export declare function parseAgentComponentData(data: ComponentData): {
    componentId: string;
} | null;
export declare function parseDiscordComponentData(data: ComponentData, customId?: string): {
    componentId: string;
    modalId?: string;
} | null;
export declare function parseDiscordModalId(data: ComponentData, customId?: string): string | null;
export declare function resolveInteractionCustomId(interaction: AgentComponentInteraction): string | undefined;
export declare function mapSelectValues(entry: DiscordComponentEntry, values: string[]): string[];
export declare function resolveModalFieldValues(field: DiscordModalEntry["fields"][number], interaction: ModalInteraction): string[];
export declare function formatModalSubmissionText(entry: DiscordModalEntry, interaction: ModalInteraction): string;
export declare function resolveDiscordInteractionId(interaction: AgentComponentInteraction): string;
