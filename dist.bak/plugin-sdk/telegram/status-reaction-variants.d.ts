import { type StatusReactionEmojis } from "../channels/status-reactions.js";
type StatusReactionEmojiKey = keyof Required<StatusReactionEmojis>;
export declare const TELEGRAM_STATUS_REACTION_VARIANTS: Record<StatusReactionEmojiKey, string[]>;
export declare function resolveTelegramStatusReactionEmojis(params: {
    initialEmoji: string;
    overrides?: StatusReactionEmojis;
}): Required<StatusReactionEmojis>;
export declare function buildTelegramStatusReactionVariants(emojis: Required<StatusReactionEmojis>): Map<string, string[]>;
export declare function isTelegramSupportedReactionEmoji(emoji: string): boolean;
export declare function extractTelegramAllowedEmojiReactions(chat: unknown): Set<string> | null | undefined;
export declare function resolveTelegramAllowedEmojiReactions(params: {
    chat: unknown;
    chatId: string | number;
    getChat?: (chatId: string | number) => Promise<unknown>;
}): Promise<Set<string> | null>;
export declare function resolveTelegramReactionVariant(params: {
    requestedEmoji: string;
    variantsByRequestedEmoji: Map<string, string[]>;
    allowedEmojiReactions?: Set<string> | null;
}): string | undefined;
export {};
