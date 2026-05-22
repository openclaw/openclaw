import { parseDiscordModalCustomIdForInteraction } from "../component-custom-id.js";
import { Modal, type ComponentData, type ModalInteraction } from "../internal/discord.js";
import { type AgentComponentContext } from "./agent-components-helpers.js";
export declare class DiscordComponentModal extends Modal {
    title: string;
    customId: string;
    components: never[];
    customIdParser: typeof parseDiscordModalCustomIdForInteraction;
    private ctx;
    constructor(ctx: AgentComponentContext);
    run(interaction: ModalInteraction, data: ComponentData): Promise<void>;
}
