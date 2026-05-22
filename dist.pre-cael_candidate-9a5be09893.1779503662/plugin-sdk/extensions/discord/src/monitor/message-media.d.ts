import { type APIAttachment, type APIStickerItem } from "discord-api-types/v10";
import { type FetchLike } from "openclaw/plugin-sdk/media-runtime";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import type { Message } from "../internal/discord.js";
export type DiscordMediaInfo = {
    path: string;
    contentType?: string;
    placeholder: string;
};
export type DiscordMediaResolveOptions = {
    fetchImpl?: FetchLike;
    ssrfPolicy?: SsrFPolicy;
    readIdleTimeoutMs?: number;
    totalTimeoutMs?: number;
    abortSignal?: AbortSignal;
};
export declare function resolveMediaList(message: Message, maxBytes: number, options?: DiscordMediaResolveOptions): Promise<DiscordMediaInfo[]>;
export declare function resolveForwardedMediaList(message: Message, maxBytes: number, options?: DiscordMediaResolveOptions): Promise<DiscordMediaInfo[]>;
export declare function resolveReferencedReplyMediaList(message: Message, maxBytes: number, options?: DiscordMediaResolveOptions): Promise<DiscordMediaInfo[]>;
export declare function buildDiscordMediaPlaceholder(params: {
    attachments?: APIAttachment[];
    stickers?: APIStickerItem[];
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
