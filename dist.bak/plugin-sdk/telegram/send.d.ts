import type { InlineKeyboardMarkup } from "@grammyjs/types";
import { Bot } from "grammy";
import { loadConfig } from "../config/config.js";
import type { RetryConfig } from "../infra/retry.js";
import { type PollInput } from "../polls.js";
import type { TelegramInlineButtons } from "./button-types.js";
type TelegramApi = Bot["api"];
type TelegramApiOverride = Partial<TelegramApi>;
type TelegramSendOpts = {
    token?: string;
    accountId?: string;
    verbose?: boolean;
    mediaUrl?: string;
    mediaLocalRoots?: readonly string[];
    maxBytes?: number;
    api?: TelegramApiOverride;
    retry?: RetryConfig;
    textMode?: "markdown" | "html";
    plainText?: string;
    /** Send audio as voice message (voice bubble) instead of audio file. Defaults to false. */
    asVoice?: boolean;
    /** Send video as video note (voice bubble) instead of regular video. Defaults to false. */
    asVideoNote?: boolean;
    /** Send message silently (no notification). Defaults to false. */
    silent?: boolean;
    /** Message ID to reply to (for threading) */
    replyToMessageId?: number;
    /** Quote text for Telegram reply_parameters. */
    quoteText?: string;
    /** Forum topic thread ID (for forum supergroups) */
    messageThreadId?: number;
    /** Inline keyboard buttons (reply markup). */
    buttons?: TelegramInlineButtons;
};
type TelegramSendResult = {
    messageId: string;
    chatId: string;
};
type TelegramReactionOpts = {
    token?: string;
    accountId?: string;
    api?: TelegramApiOverride;
    remove?: boolean;
    verbose?: boolean;
    retry?: RetryConfig;
};
export declare function buildInlineKeyboard(buttons?: TelegramSendOpts["buttons"]): InlineKeyboardMarkup | undefined;
export declare function sendMessageTelegram(to: string, text: string, opts?: TelegramSendOpts): Promise<TelegramSendResult>;
export declare function reactMessageTelegram(chatIdInput: string | number, messageIdInput: string | number, emoji: string, opts?: TelegramReactionOpts): Promise<{
    ok: true;
} | {
    ok: false;
    warning: string;
}>;
type TelegramDeleteOpts = {
    token?: string;
    accountId?: string;
    verbose?: boolean;
    api?: TelegramApiOverride;
    retry?: RetryConfig;
};
export declare function deleteMessageTelegram(chatIdInput: string | number, messageIdInput: string | number, opts?: TelegramDeleteOpts): Promise<{
    ok: true;
}>;
type TelegramEditOpts = {
    token?: string;
    accountId?: string;
    verbose?: boolean;
    api?: TelegramApiOverride;
    retry?: RetryConfig;
    textMode?: "markdown" | "html";
    /** Controls whether link previews are shown in the edited message. */
    linkPreview?: boolean;
    /** Inline keyboard buttons (reply markup). Pass empty array to remove buttons. */
    buttons?: TelegramInlineButtons;
    /** Optional config injection to avoid global loadConfig() (improves testability). */
    cfg?: ReturnType<typeof loadConfig>;
};
export declare function editMessageTelegram(chatIdInput: string | number, messageIdInput: string | number, text: string, opts?: TelegramEditOpts): Promise<{
    ok: true;
    messageId: string;
    chatId: string;
}>;
type TelegramStickerOpts = {
    token?: string;
    accountId?: string;
    verbose?: boolean;
    api?: TelegramApiOverride;
    retry?: RetryConfig;
    /** Message ID to reply to (for threading) */
    replyToMessageId?: number;
    /** Forum topic thread ID (for forum supergroups) */
    messageThreadId?: number;
};
/**
 * Send a sticker to a Telegram chat by file_id.
 * @param to - Chat ID or username (e.g., "123456789" or "@username")
 * @param fileId - Telegram file_id of the sticker to send
 * @param opts - Optional configuration
 */
export declare function sendStickerTelegram(to: string, fileId: string, opts?: TelegramStickerOpts): Promise<TelegramSendResult>;
type TelegramPollOpts = {
    token?: string;
    accountId?: string;
    verbose?: boolean;
    api?: TelegramApiOverride;
    retry?: RetryConfig;
    /** Message ID to reply to (for threading) */
    replyToMessageId?: number;
    /** Forum topic thread ID (for forum supergroups) */
    messageThreadId?: number;
    /** Send message silently (no notification). Defaults to false. */
    silent?: boolean;
    /** Whether votes are anonymous. Defaults to true (Telegram default). */
    isAnonymous?: boolean;
};
/**
 * Send a poll to a Telegram chat.
 * @param to - Chat ID or username (e.g., "123456789" or "@username")
 * @param poll - Poll input with question, options, maxSelections, and optional durationHours
 * @param opts - Optional configuration
 */
export declare function sendPollTelegram(to: string, poll: PollInput, opts?: TelegramPollOpts): Promise<{
    messageId: string;
    chatId: string;
    pollId?: string;
}>;
type TelegramCreateForumTopicOpts = {
    token?: string;
    accountId?: string;
    api?: Bot["api"];
    verbose?: boolean;
    retry?: RetryConfig;
    /** Icon color for the topic (must be one of 0x6FB9F0, 0xFFD67E, 0xCB86DB, 0x8EEE98, 0xFF93B2, 0xFB6F5F). */
    iconColor?: number;
    /** Custom emoji ID for the topic icon. */
    iconCustomEmojiId?: string;
};
export type TelegramCreateForumTopicResult = {
    topicId: number;
    name: string;
    chatId: string;
};
/**
 * Create a forum topic in a Telegram supergroup.
 * Requires the bot to have `can_manage_topics` permission.
 *
 * @param chatId - Supergroup chat ID
 * @param name - Topic name (1-128 characters)
 * @param opts - Optional configuration
 */
export declare function createForumTopicTelegram(chatId: string, name: string, opts?: TelegramCreateForumTopicOpts): Promise<TelegramCreateForumTopicResult>;
export {};
