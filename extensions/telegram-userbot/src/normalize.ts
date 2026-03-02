/**
 * Chat ID normalization for consistent routing in the telegram-userbot channel.
 *
 * Telegram chat IDs come in various shapes (number, bigint, string);
 * these helpers collapse them into a single canonical string form and
 * provide round-trip formatting with the OpenClaw channel prefix.
 */

export const CHANNEL_PREFIX = "telegram-userbot";

/**
 * Normalize a Telegram chat ID to a consistent string format.
 * - User DMs: "267619672"
 * - Groups/supergroups: "-1001234567890" (keep the negative prefix)
 * - Channels: "-1001234567890"
 */
export function normalizeChatId(chatId: number | bigint | string): string {
  const id =
    typeof chatId === "bigint"
      ? Number(chatId)
      : typeof chatId === "string"
        ? Number(chatId)
        : chatId;
  return String(id);
}

/**
 * Format a chat ID with channel prefix for OpenClaw routing.
 * Returns "telegram-userbot:267619672"
 */
export function formatChannelChatId(chatId: number | bigint | string): string {
  return `${CHANNEL_PREFIX}:${normalizeChatId(chatId)}`;
}

/**
 * Parse an OpenClaw channel chat ID back to numeric form.
 * "telegram-userbot:267619672" → 267619672
 */
export function parseChannelChatId(channelChatId: string): number {
  const prefix = `${CHANNEL_PREFIX}:`;
  if (channelChatId.startsWith(prefix)) {
    return Number(channelChatId.slice(prefix.length));
  }
  return Number(channelChatId);
}
