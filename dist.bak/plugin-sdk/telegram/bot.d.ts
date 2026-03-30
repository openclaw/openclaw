import { type Message, type UserFromGetMe } from "@grammyjs/types";
import { Bot } from "grammy";
import type { OpenClawConfig, ReplyToMode } from "../config/config.js";
import { type RuntimeEnv } from "../runtime.js";
export type TelegramBotOptions = {
    token: string;
    accountId?: string;
    runtime?: RuntimeEnv;
    requireMention?: boolean;
    allowFrom?: Array<string | number>;
    groupAllowFrom?: Array<string | number>;
    mediaMaxMb?: number;
    replyToMode?: ReplyToMode;
    proxyFetch?: typeof fetch;
    config?: OpenClawConfig;
    updateOffset?: {
        lastUpdateId?: number | null;
        onUpdateId?: (updateId: number) => void | Promise<void>;
    };
    testTimings?: {
        mediaGroupFlushMs?: number;
        textFragmentGapMs?: number;
    };
};
export declare function getTelegramSequentialKey(ctx: {
    chat?: {
        id?: number;
    };
    me?: UserFromGetMe;
    message?: Message;
    channelPost?: Message;
    editedChannelPost?: Message;
    update?: {
        message?: Message;
        edited_message?: Message;
        channel_post?: Message;
        edited_channel_post?: Message;
        callback_query?: {
            message?: Message;
        };
        message_reaction?: {
            chat?: {
                id?: number;
            };
        };
    };
}): string;
export declare function createTelegramBot(opts: TelegramBotOptions): Bot<import("grammy").Context, import("grammy").Api<import("grammy").RawApi>>;
export declare function createTelegramWebhookCallback(bot: Bot, path?: string): {
    path: string;
    handler: (req: {
        headers: Record<string, string | string[] | undefined>;
        on: (event: string, listener: (chunk: unknown) => void) => /*elided*/ any;
        once: (event: string, listener: () => void) => /*elided*/ any;
    }, res: {
        writeHead: {
            (status: number): /*elided*/ any;
            (status: number, headers: Record<string, string>): /*elided*/ any;
        };
        end: (json?: string) => void;
    }) => Promise<void>;
};
