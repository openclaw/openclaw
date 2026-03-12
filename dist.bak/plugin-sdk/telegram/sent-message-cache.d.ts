/**
 * In-memory cache of sent message IDs per chat.
 * Used to identify bot's own messages for reaction filtering ("own" mode).
 */
/**
 * Record a message ID as sent by the bot.
 */
export declare function recordSentMessage(chatId: number | string, messageId: number): void;
/**
 * Check if a message was sent by the bot.
 */
export declare function wasSentByBot(chatId: number | string, messageId: number): boolean;
/**
 * Clear all cached entries (for testing).
 */
export declare function clearSentMessageCache(): void;
