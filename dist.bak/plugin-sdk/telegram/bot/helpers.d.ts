import type { Chat, Message } from "@grammyjs/types";
import { type NormalizedLocation } from "../../channels/location.js";
import type { TelegramGroupConfig, TelegramTopicConfig } from "../../config/types.js";
import { type NormalizedAllowFrom } from "../bot-access.js";
import type { TelegramStreamMode } from "./types.js";
export type TelegramThreadSpec = {
    id?: number;
    scope: "dm" | "forum" | "none";
};
export declare function resolveTelegramGroupAllowFromContext(params: {
    chatId: string | number;
    accountId?: string;
    isForum?: boolean;
    messageThreadId?: number | null;
    groupAllowFrom?: Array<string | number>;
    resolveTelegramGroupConfig: (chatId: string | number, messageThreadId?: number) => {
        groupConfig?: TelegramGroupConfig;
        topicConfig?: TelegramTopicConfig;
    };
}): Promise<{
    resolvedThreadId?: number;
    storeAllowFrom: string[];
    groupConfig?: TelegramGroupConfig;
    topicConfig?: TelegramTopicConfig;
    groupAllowOverride?: Array<string | number>;
    effectiveGroupAllow: NormalizedAllowFrom;
    hasGroupAllowOverride: boolean;
}>;
/**
 * Resolve the thread ID for Telegram forum topics.
 * For non-forum groups, returns undefined even if messageThreadId is present
 * (reply threads in regular groups should not create separate sessions).
 * For forum groups, returns the topic ID (or General topic ID=1 if unspecified).
 */
export declare function resolveTelegramForumThreadId(params: {
    isForum?: boolean;
    messageThreadId?: number | null;
}): number | undefined;
export declare function resolveTelegramThreadSpec(params: {
    isGroup: boolean;
    isForum?: boolean;
    messageThreadId?: number | null;
}): TelegramThreadSpec;
/**
 * Build thread params for Telegram API calls (messages, media).
 *
 * IMPORTANT: Thread IDs behave differently based on chat type:
 * - DMs (private chats): Include message_thread_id when present (DM topics)
 * - Forum topics: Skip thread_id=1 (General topic), include others
 * - Regular groups: Thread IDs are ignored by Telegram
 *
 * General forum topic (id=1) must be treated like a regular supergroup send:
 * Telegram rejects sendMessage/sendMedia with message_thread_id=1 ("thread not found").
 *
 * @param thread - Thread specification with ID and scope
 * @returns API params object or undefined if thread_id should be omitted
 */
export declare function buildTelegramThreadParams(thread?: TelegramThreadSpec | null): {
    message_thread_id: number;
} | undefined;
/**
 * Build thread params for typing indicators (sendChatAction).
 * Empirically, General topic (id=1) needs message_thread_id for typing to appear.
 */
export declare function buildTypingThreadParams(messageThreadId?: number): {
    message_thread_id: number;
} | undefined;
export declare function resolveTelegramStreamMode(telegramCfg?: {
    streaming?: unknown;
    streamMode?: unknown;
}): TelegramStreamMode;
export declare function buildTelegramGroupPeerId(chatId: number | string, messageThreadId?: number): string;
export declare function buildTelegramGroupFrom(chatId: number | string, messageThreadId?: number): string;
/**
 * Build parentPeer for forum topic binding inheritance.
 * When a message comes from a forum topic, the peer ID includes the topic suffix
 * (e.g., `-1001234567890:topic:99`). To allow bindings configured for the base
 * group ID to match, we provide the parent group as `parentPeer` so the routing
 * layer can fall back to it when the exact peer doesn't match.
 */
export declare function buildTelegramParentPeer(params: {
    isGroup: boolean;
    resolvedThreadId?: number;
    chatId: number | string;
}): {
    kind: "group";
    id: string;
} | undefined;
export declare function buildSenderName(msg: Message): string | undefined;
export declare function resolveTelegramMediaPlaceholder(msg: Pick<Message, "photo" | "video" | "video_note" | "audio" | "voice" | "document" | "sticker"> | undefined | null): string | undefined;
export declare function buildSenderLabel(msg: Message, senderId?: number | string): string;
export declare function buildGroupLabel(msg: Message, chatId: number | string, messageThreadId?: number): string;
export declare function hasBotMention(msg: Message, botUsername: string): boolean;
type TelegramTextLinkEntity = {
    type: string;
    offset: number;
    length: number;
    url?: string;
};
export declare function expandTextLinks(text: string, entities?: TelegramTextLinkEntity[] | null): string;
export declare function resolveTelegramReplyId(raw?: string): number | undefined;
export type TelegramReplyTarget = {
    id?: string;
    sender: string;
    body: string;
    kind: "reply" | "quote";
    /** Forward context if the reply target was itself a forwarded message (issue #9619). */
    forwardedFrom?: TelegramForwardedContext;
};
export declare function describeReplyTarget(msg: Message): TelegramReplyTarget | null;
export type TelegramForwardedContext = {
    from: string;
    date?: number;
    fromType: string;
    fromId?: string;
    fromUsername?: string;
    fromTitle?: string;
    fromSignature?: string;
    /** Original chat type from forward_from_chat (e.g. "channel", "supergroup", "group"). */
    fromChatType?: Chat["type"];
    /** Original message ID in the source chat (channel forwards). */
    fromMessageId?: number;
};
/** Extract forwarded message origin info from Telegram message. */
export declare function normalizeForwardedContext(msg: Message): TelegramForwardedContext | null;
export declare function extractTelegramLocation(msg: Message): NormalizedLocation | null;
export {};
