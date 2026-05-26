import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { n as PollInput } from "./polls-CfHkU59X.js";
import { t as RetryConfig } from "./retry-CrxGEpqH.js";
import { Bot } from "grammy";
//#region extensions/telegram/src/button-types.d.ts
type TelegramButtonStyle = "danger" | "success" | "primary";
type TelegramInlineButton = {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: {
    url: string;
  };
  style?: TelegramButtonStyle;
};
type TelegramInlineButtons = ReadonlyArray<ReadonlyArray<TelegramInlineButton>>;
//#endregion
//#region extensions/telegram/src/send.d.ts
type TelegramApi = Bot["api"];
type TelegramApiOverride = Partial<TelegramApi>;
type TelegramCreateForumTopicParams = NonNullable<Parameters<TelegramApi["createForumTopic"]>[2]>;
type TelegramSendOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  verbose?: boolean;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  gatewayClientScopes?: readonly string[];
  maxBytes?: number;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  textMode?: "markdown" | "html";
  plainText?: string; /** Send audio as voice message instead of audio file. Defaults to false. */
  asVoice?: boolean; /** Send video as video note instead of regular video. Defaults to false. */
  asVideoNote?: boolean; /** Send message silently (no notification). Defaults to false. */
  silent?: boolean; /** Message ID to reply to (for threading) */
  replyToMessageId?: number; /** Quote text for Telegram reply_parameters. */
  quoteText?: string; /** Forum topic thread ID (for forum supergroups) */
  messageThreadId?: number; /** Inline keyboard buttons (reply markup). */
  buttons?: TelegramInlineButtons; /** Send image as document to avoid Telegram compression. Defaults to false. */
  forceDocument?: boolean;
};
type TelegramSendResult = {
  messageId: string;
  chatId: string;
};
type TelegramReactionOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  api?: TelegramApiOverride;
  remove?: boolean;
  verbose?: boolean;
  retry?: RetryConfig;
  gatewayClientScopes?: readonly string[];
};
type TelegramTypingOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  messageThreadId?: number;
};
declare function sendMessageTelegram(to: string, text: string, opts: TelegramSendOpts): Promise<TelegramSendResult>;
declare function sendTypingTelegram(to: string, opts: TelegramTypingOpts): Promise<{
  ok: true;
}>;
declare function reactMessageTelegram(chatIdInput: string | number, messageIdInput: string | number, emoji: string, opts: TelegramReactionOpts): Promise<{
  ok: true;
} | {
  ok: false;
  warning: string;
}>;
type TelegramDeleteOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  notify?: boolean;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  gatewayClientScopes?: readonly string[];
};
declare function deleteMessageTelegram(chatIdInput: string | number, messageIdInput: string | number, opts: TelegramDeleteOpts): Promise<{
  ok: true;
} | {
  ok: false;
  warning: string;
}>;
declare function pinMessageTelegram(chatIdInput: string | number, messageIdInput: string | number, opts: TelegramDeleteOpts): Promise<{
  ok: true;
  messageId: string;
  chatId: string;
}>;
declare function unpinMessageTelegram(chatIdInput: string | number, messageIdInput: string | number | undefined, opts: TelegramDeleteOpts): Promise<{
  ok: true;
  chatId: string;
  messageId?: string;
}>;
type TelegramEditForumTopicOpts = TelegramDeleteOpts & {
  name?: string;
  iconCustomEmojiId?: string;
};
declare function editForumTopicTelegram(chatIdInput: string | number, messageThreadIdInput: string | number, opts: TelegramEditForumTopicOpts): Promise<{
  ok: true;
  chatId: string;
  messageThreadId: number;
  name?: string;
  iconCustomEmojiId?: string;
}>;
declare function renameForumTopicTelegram(chatIdInput: string | number, messageThreadIdInput: string | number, name: string, opts: TelegramDeleteOpts): Promise<{
  ok: true;
  chatId: string;
  messageThreadId: number;
  name: string;
}>;
type TelegramEditOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  gatewayClientScopes?: readonly string[];
  textMode?: "markdown" | "html"; /** Controls whether link previews are shown in the edited message. */
  linkPreview?: boolean; /** Inline keyboard buttons (reply markup). Pass empty array to remove buttons. */
  buttons?: TelegramInlineButtons; /** Resolved runtime config from the command or gateway boundary. */
  cfg: OpenClawConfig;
};
type TelegramEditReplyMarkupOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  gatewayClientScopes?: readonly string[]; /** Inline keyboard buttons (reply markup). Pass empty array to remove buttons. */
  buttons?: TelegramInlineButtons; /** Resolved runtime config from the command or gateway boundary. */
  cfg: OpenClawConfig;
};
declare function editMessageReplyMarkupTelegram(chatIdInput: string | number, messageIdInput: string | number, buttons: TelegramInlineButtons, opts: TelegramEditReplyMarkupOpts): Promise<{
  ok: true;
  messageId: string;
  chatId: string;
}>;
declare function editMessageTelegram(chatIdInput: string | number, messageIdInput: string | number, text: string, opts: TelegramEditOpts): Promise<{
  ok: true;
  messageId: string;
  chatId: string;
}>;
type TelegramStickerOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  gatewayClientScopes?: readonly string[]; /** Message ID to reply to (for threading) */
  replyToMessageId?: number; /** Forum topic thread ID (for forum supergroups) */
  messageThreadId?: number;
};
/**
 * Send a sticker to a Telegram chat by file_id.
 * @param to - Chat ID or username (e.g., "123456789" or "@username")
 * @param fileId - Telegram file_id of the sticker to send
 * @param opts - Optional configuration
 */
declare function sendStickerTelegram(to: string, fileId: string, opts: TelegramStickerOpts): Promise<TelegramSendResult>;
type TelegramPollOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  verbose?: boolean;
  api?: TelegramApiOverride;
  retry?: RetryConfig;
  gatewayClientScopes?: readonly string[]; /** Message ID to reply to (for threading) */
  replyToMessageId?: number; /** Forum topic thread ID (for forum supergroups) */
  messageThreadId?: number; /** Send message silently (no notification). Defaults to false. */
  silent?: boolean; /** Whether votes are anonymous. Defaults to true (Telegram default). */
  isAnonymous?: boolean;
};
/**
 * Send a poll to a Telegram chat.
 * @param to - Chat ID or username (e.g., "123456789" or "@username")
 * @param poll - Poll input with question, options, maxSelections, and optional durationHours
 * @param opts - Optional configuration
 */
declare function sendPollTelegram(to: string, poll: PollInput, opts: TelegramPollOpts): Promise<{
  messageId: string;
  chatId: string;
  pollId?: string;
}>;
type TelegramCreateForumTopicOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  api?: TelegramApiOverride;
  verbose?: boolean;
  retry?: RetryConfig;
  gatewayClientScopes?: readonly string[]; /** Icon color for the topic (must be one of 0x6FB9F0, 0xFFD67E, 0xCB86DB, 0x8EEE98, 0xFF93B2, 0xFB6F5F). */
  iconColor?: TelegramCreateForumTopicParams["icon_color"]; /** Custom emoji ID for the topic icon. */
  iconCustomEmojiId?: string;
};
type TelegramCreateForumTopicResult = {
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
declare function createForumTopicTelegram(chatId: string, name: string, opts: TelegramCreateForumTopicOpts): Promise<TelegramCreateForumTopicResult>;
//#endregion
export { editMessageReplyMarkupTelegram as a, reactMessageTelegram as c, sendPollTelegram as d, sendStickerTelegram as f, TelegramInlineButtons as g, TelegramButtonStyle as h, editForumTopicTelegram as i, renameForumTopicTelegram as l, unpinMessageTelegram as m, createForumTopicTelegram as n, editMessageTelegram as o, sendTypingTelegram as p, deleteMessageTelegram as r, pinMessageTelegram as s, TelegramApiOverride as t, sendMessageTelegram as u };