import type { ChannelType, Client, Message } from "@buape/carbon";
import { type APIStickerItem } from "discord-api-types/v10";
import { type FetchLike } from "../../media/fetch.js";
export type DiscordMediaInfo = {
    path: string;
    contentType?: string;
    placeholder: string;
};
export type DiscordChannelInfo = {
    type: ChannelType;
    name?: string;
    topic?: string;
    parentId?: string;
    ownerId?: string;
};
export declare function __resetDiscordChannelInfoCacheForTest(): void;
export declare function resolveDiscordMessageChannelId(params: {
    message: Message;
    eventChannelId?: string | number | null;
}): string;
export declare function resolveDiscordChannelInfo(client: Client, channelId: string): Promise<DiscordChannelInfo | null>;
export declare function resolveDiscordMessageStickers(message: Message): APIStickerItem[];
export declare function hasDiscordMessageStickers(message: Message): boolean;
export declare function resolveMediaList(message: Message, maxBytes: number, fetchImpl?: FetchLike): Promise<DiscordMediaInfo[]>;
export declare function resolveForwardedMediaList(message: Message, maxBytes: number, fetchImpl?: FetchLike): Promise<DiscordMediaInfo[]>;
export declare function resolveDiscordEmbedText(embed?: {
    title?: string | null;
    description?: string | null;
} | null): string;
export declare function resolveDiscordMessageText(message: Message, options?: {
    fallbackText?: string;
    includeForwarded?: boolean;
}): string;
export declare function buildDiscordMediaPayload(mediaList: Array<{
    path: string;
    contentType?: string;
}>): {
    MediaPath?: string;
    MediaType?: string;
    MediaUrl?: string;
    MediaPaths?: string[];
    MediaUrls?: string[];
    MediaTypes?: string[];
};
