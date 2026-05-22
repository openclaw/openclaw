import type { Message } from "../internal/discord.js";
export declare function resolveDiscordEmbedText(embed?: {
    title?: string | null;
    description?: string | null;
} | null): string;
export declare function resolveDiscordMessageText(message: Message, options?: {
    fallbackText?: string;
    includeForwarded?: boolean;
}): string;
export declare function resolveDiscordForwardedMessagesTextFromSnapshots(snapshots: unknown): string;
