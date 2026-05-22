import { MessageFlags, type APIEmbed } from "discord-api-types/v10";
import { Embed, type MessagePayloadFile, type MessagePayloadObject, type TopLevelComponents } from "./internal/discord.js";
export declare const SUPPRESS_EMBEDS_FLAG = MessageFlags.SuppressEmbeds;
export declare const SUPPRESS_NOTIFICATIONS_FLAG = MessageFlags.SuppressNotifications;
export type DiscordSendComponentFactory = (text: string) => TopLevelComponents[];
export type DiscordSendComponents = TopLevelComponents[] | DiscordSendComponentFactory;
export type DiscordSendEmbeds = Array<APIEmbed | Embed>;
export declare function resolveDiscordSendComponents(params: {
    components?: DiscordSendComponents;
    text: string;
    isFirst: boolean;
}): TopLevelComponents[] | undefined;
export declare function resolveDiscordSendEmbeds(params: {
    embeds?: DiscordSendEmbeds;
    isFirst: boolean;
}): Embed[] | undefined;
export declare function buildDiscordMessagePayload(params: {
    text: string;
    components?: TopLevelComponents[];
    embeds?: Embed[];
    flags?: number;
    files?: MessagePayloadFile[];
}): MessagePayloadObject;
export declare function resolveDiscordMessageFlags(params: {
    silent?: boolean;
    suppressEmbeds?: boolean;
}): number | undefined;
export declare function buildDiscordMessageRequest(params: {
    text: string;
    components?: TopLevelComponents[];
    embeds?: Embed[];
    files?: MessagePayloadFile[];
    flags?: number;
    replyTo?: string;
}): {
    content: string;
    message_reference?: {
        message_id: string;
        fail_if_not_exists: boolean;
    } | undefined;
} | {
    content: string | undefined;
    embeds: APIEmbed[] | undefined;
    components: unknown[] | undefined;
    allowed_mentions: unknown;
    flags: number | undefined;
    tts: boolean | undefined;
    files: MessagePayloadFile[] | undefined;
    poll: unknown;
    sticker_ids: [string] | [string, string] | [string, string, string] | undefined;
    message_reference?: {
        message_id: string;
        fail_if_not_exists: boolean;
    } | undefined;
};
export declare function stripUndefinedFields<T extends object>(value: T): T;
