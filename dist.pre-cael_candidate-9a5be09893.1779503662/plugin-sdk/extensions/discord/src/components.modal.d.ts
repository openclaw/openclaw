import { parseDiscordModalCustomIdForInteraction as parseDiscordModalCustomIdForInteractionImpl } from "./component-custom-id.js";
import type { DiscordModalEntry, DiscordModalFieldDefinition } from "./components.types.js";
import { Label, Modal, TextDisplay } from "./internal/discord.js";
declare const ModalBase: typeof Modal;
export declare class DiscordFormModal extends ModalBase {
    title: string;
    customId: string;
    components: Array<Label | TextDisplay>;
    customIdParser: typeof parseDiscordModalCustomIdForInteractionImpl;
    constructor(params: {
        modalId: string;
        title: string;
        fields: DiscordModalFieldDefinition[];
    });
    run(): Promise<void>;
}
export declare function createDiscordFormModal(entry: DiscordModalEntry): Modal;
export {};
