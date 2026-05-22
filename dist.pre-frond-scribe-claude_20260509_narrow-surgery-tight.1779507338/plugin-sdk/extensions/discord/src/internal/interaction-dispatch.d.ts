import { type APIInteraction } from "discord-api-types/v10";
import { type BaseCommand } from "./commands.js";
import { BaseComponentInteraction, ModalInteraction, createInteraction } from "./interactions.js";
type DispatchComponent = {
    defer: boolean | ((interaction: BaseComponentInteraction) => boolean);
    ephemeral: boolean | ((interaction: BaseComponentInteraction) => boolean);
    run(interaction: BaseComponentInteraction, data: Record<string, unknown>): unknown;
    customIdParser(id: string): {
        data: Record<string, unknown>;
    };
};
type DispatchModal = {
    run(interaction: ModalInteraction, data: Record<string, unknown>): unknown;
    customIdParser(id: string): {
        data: Record<string, unknown>;
    };
};
type DispatchClient = Parameters<typeof createInteraction>[0] & {
    commands: BaseCommand[];
    componentHandler: {
        resolve(customId: string, options?: {
            componentType?: number;
        }): DispatchComponent | undefined;
        resolveOneOffComponent(params: {
            channelId?: string;
            customId: string;
            messageId?: string;
            values?: string[];
        }): boolean;
    };
    modalHandler: {
        resolve(customId: string): DispatchModal | undefined;
    };
};
export declare function dispatchInteraction(client: DispatchClient, rawData: APIInteraction): Promise<void>;
export {};
