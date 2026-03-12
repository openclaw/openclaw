import type { Bot } from "grammy";
import { type TelegramThreadSpec } from "./bot/helpers.js";
export type TelegramDraftStream = {
    update: (text: string) => void;
    flush: () => Promise<void>;
    messageId: () => number | undefined;
    clear: () => Promise<void>;
    stop: () => Promise<void>;
    /** Reset internal state so the next update creates a new message instead of editing. */
    forceNewMessage: () => void;
};
type TelegramDraftPreview = {
    text: string;
    parseMode?: "HTML";
};
type SupersededTelegramPreview = {
    messageId: number;
    textSnapshot: string;
    parseMode?: "HTML";
};
export declare function createTelegramDraftStream(params: {
    api: Bot["api"];
    chatId: number;
    maxChars?: number;
    thread?: TelegramThreadSpec | null;
    replyToMessageId?: number;
    throttleMs?: number;
    /** Minimum chars before sending first message (debounce for push notifications) */
    minInitialChars?: number;
    /** Optional preview renderer (e.g. markdown -> HTML + parse mode). */
    renderText?: (text: string) => TelegramDraftPreview;
    /** Called when a late send resolves after forceNewMessage() switched generations. */
    onSupersededPreview?: (preview: SupersededTelegramPreview) => void;
    log?: (message: string) => void;
    warn?: (message: string) => void;
}): TelegramDraftStream;
export {};
