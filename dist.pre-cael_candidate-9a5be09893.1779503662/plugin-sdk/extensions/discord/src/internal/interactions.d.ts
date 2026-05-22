import { InteractionResponseType, type APIApplicationCommandInteraction, type APIApplicationCommandInteractionDataOption, type APIInteraction, type APIInteractionDataResolvedChannel, type APIMessageComponentInteraction, type APIModalSubmitInteraction, type APIUser } from "discord-api-types/v10";
import { OptionsHandler } from "./interaction-options.js";
import { type InteractionResponseState } from "./interaction-response.js";
import { ModalFields } from "./modal-fields.js";
import { type MessagePayload } from "./payload.js";
import { Guild, Message, User, type DiscordChannel, type StructureClient } from "./structures.js";
export { OptionsHandler } from "./interaction-options.js";
export { ModalFields } from "./modal-fields.js";
type InteractionClient = StructureClient & {
    options: {
        clientId: string;
    };
    componentHandler: {
        waitForMessageComponent(message: Message, timeoutMs: number): Promise<{
            success: true;
            customId: string;
            message: Message;
            values?: string[];
        } | {
            success: false;
            message: Message;
            reason: "timed out";
        }>;
    };
    fetchChannel(id: string): Promise<DiscordChannel>;
};
type Modal = {
    serialize: () => unknown;
};
type ComponentData = Record<string, unknown>;
export type RawInteraction = APIInteraction & {
    token: string;
    member?: {
        user?: APIUser;
        roles?: string[];
    };
    guild_id?: string;
    channel_id?: string;
    channel?: unknown;
    data?: {
        custom_id?: string;
        component_type?: number;
        values?: string[];
        components?: unknown[];
        options?: APIApplicationCommandInteractionDataOption[];
        resolved?: {
            channels?: Record<string, APIInteractionDataResolvedChannel>;
            roles?: Record<string, {
                id: string;
                name?: string;
            }>;
            users?: Record<string, {
                id: string;
                username?: string;
                discriminator?: string;
            }>;
        };
    };
    message?: unknown;
};
export declare class BaseInteraction {
    client: InteractionClient;
    rawData: RawInteraction;
    readonly id: string;
    readonly token: string;
    readonly user: User | null;
    readonly userId: string;
    readonly guild: Guild | null;
    readonly channel: DiscordChannel | null;
    message: Message | null;
    private readonly response;
    constructor(client: InteractionClient, rawData: RawInteraction);
    get acknowledged(): boolean;
    get responseState(): InteractionResponseState;
    set responseState(nextState: InteractionResponseState);
    protected callback(type: InteractionResponseType, data?: unknown): Promise<unknown>;
    reply(payload: MessagePayload): Promise<unknown>;
    defer(options?: {
        ephemeral?: boolean;
    }): Promise<unknown>;
    acknowledge(): Promise<unknown>;
    editReply(payload: MessagePayload): Promise<unknown>;
    deleteReply(): Promise<unknown>;
    fetchReply(): Promise<unknown>;
    replyAndWaitForComponent(payload: MessagePayload, timeoutMs?: number): Promise<{
        success: true;
        customId: string;
        message: Message;
        values?: string[];
    } | {
        success: false;
        message: Message;
        reason: "timed out";
    }>;
    followUp(payload: MessagePayload): Promise<unknown>;
}
export declare class CommandInteraction extends BaseInteraction {
    readonly options: OptionsHandler;
    constructor(client: InteractionClient, rawData: APIApplicationCommandInteraction & RawInteraction);
}
export declare class AutocompleteInteraction extends CommandInteraction {
    respond(choices: Array<{
        name: string;
        value: string | number;
    }>): Promise<unknown>;
}
export declare class BaseComponentInteraction extends BaseInteraction {
    readonly values: string[];
    constructor(client: InteractionClient, rawData: APIMessageComponentInteraction & RawInteraction);
    update(payload: MessagePayload): Promise<unknown>;
    acknowledge(): Promise<unknown>;
    showModal(modal: Modal): Promise<unknown>;
    editAndWaitForComponent(payload: MessagePayload, message?: Message | null, timeoutMs?: number): Promise<{
        success: true;
        customId: string;
        message: Message;
        values?: string[];
    } | {
        success: false;
        message: Message;
        reason: "timed out";
    } | null>;
}
export declare class ButtonInteraction extends BaseComponentInteraction {
}
export declare class StringSelectMenuInteraction extends BaseComponentInteraction {
}
export declare class UserSelectMenuInteraction extends BaseComponentInteraction {
}
export declare class RoleSelectMenuInteraction extends BaseComponentInteraction {
}
export declare class MentionableSelectMenuInteraction extends BaseComponentInteraction {
}
export declare class ChannelSelectMenuInteraction extends BaseComponentInteraction {
}
export declare class ModalInteraction extends BaseInteraction {
    readonly fields: ModalFields;
    constructor(client: InteractionClient, rawData: APIModalSubmitInteraction & RawInteraction);
    acknowledge(): Promise<unknown>;
}
export declare function createInteraction(client: InteractionClient, rawData: RawInteraction): BaseInteraction;
export declare function parseComponentInteractionData(component: {
    customIdParser: (id: string) => {
        data: ComponentData;
    };
}, customId: string): ComponentData;
