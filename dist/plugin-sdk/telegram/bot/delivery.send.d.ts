import { type Bot } from "grammy";
import type { RuntimeEnv } from "../../runtime.js";
import { buildInlineKeyboard } from "../send.js";
import { type TelegramThreadSpec } from "./helpers.js";
export declare function sendTelegramWithThreadFallback<T>(params: {
    operation: string;
    runtime: RuntimeEnv;
    thread?: TelegramThreadSpec | null;
    requestParams: Record<string, unknown>;
    send: (effectiveParams: Record<string, unknown>) => Promise<T>;
    shouldLog?: (err: unknown) => boolean;
}): Promise<T>;
export declare function buildTelegramSendParams(opts?: {
    replyToMessageId?: number;
    thread?: TelegramThreadSpec | null;
}): Record<string, unknown>;
export declare function sendTelegramText(bot: Bot, chatId: string, text: string, runtime: RuntimeEnv, opts?: {
    replyToMessageId?: number;
    replyQuoteText?: string;
    thread?: TelegramThreadSpec | null;
    textMode?: "markdown" | "html";
    plainText?: string;
    linkPreview?: boolean;
    replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
}): Promise<number>;
