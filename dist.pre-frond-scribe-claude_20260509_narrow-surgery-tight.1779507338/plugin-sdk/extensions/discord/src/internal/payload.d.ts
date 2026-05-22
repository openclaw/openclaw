import { type APIEmbed } from "discord-api-types/v10";
import { Embed } from "./embeds.js";
export type MessagePayloadFile = {
    name: string;
    data: Blob | Uint8Array | ArrayBuffer;
    description?: string;
    duration_secs?: number;
    waveform?: string;
};
export type MessagePayloadObject = {
    content?: string;
    embeds?: Array<APIEmbed | Embed>;
    components?: TopLevelComponents[];
    allowedMentions?: unknown;
    allowed_mentions?: unknown;
    flags?: number;
    tts?: boolean;
    files?: MessagePayloadFile[];
    poll?: unknown;
    ephemeral?: boolean;
    stickers?: [string, string, string] | [string, string] | [string];
};
export type MessagePayload = string | MessagePayloadObject;
export type TopLevelComponents = {
    isV2?: boolean;
    serialize: () => unknown;
};
export declare function serializePayload(payload: MessagePayload): {
    content: string;
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
};
