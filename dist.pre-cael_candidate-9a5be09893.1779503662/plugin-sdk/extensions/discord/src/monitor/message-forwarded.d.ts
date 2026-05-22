import type { APIAttachment, APIStickerItem } from "discord-api-types/v10";
import type { Message } from "../internal/discord.js";
export type DiscordSnapshotAuthor = {
    id?: string | null;
    username?: string | null;
    discriminator?: string | null;
    global_name?: string | null;
    name?: string | null;
};
export type DiscordSnapshotMessage = {
    content?: string | null;
    components?: unknown;
    embeds?: Array<{
        description?: string | null;
        title?: string | null;
    }> | null;
    attachments?: APIAttachment[] | null;
    stickers?: APIStickerItem[] | null;
    sticker_items?: APIStickerItem[] | null;
    author?: DiscordSnapshotAuthor | null;
};
export type DiscordMessageSnapshot = {
    message?: DiscordSnapshotMessage | null;
};
export declare function normalizeDiscordStickerItems(value: unknown): APIStickerItem[];
export declare function resolveDiscordMessageStickers(message: Message): APIStickerItem[];
export declare function resolveDiscordSnapshotStickers(snapshot: DiscordSnapshotMessage): APIStickerItem[];
export declare function hasDiscordMessageStickers(message: Message): boolean;
export declare function resolveDiscordMessageSnapshots(message: Message): DiscordMessageSnapshot[];
export declare function normalizeDiscordMessageSnapshots(snapshots: unknown): DiscordMessageSnapshot[];
export declare function resolveDiscordReferencedForwardMessage(message: Message): Message | null;
export declare function resolveDiscordReferencedReplyMessage(message: Message): Message | null;
export declare function formatDiscordSnapshotAuthor(author: DiscordSnapshotAuthor | null | undefined): string | undefined;
