import { Bot } from "grammy";
import type { OpenClawConfig, ReplyToMode } from "../config/config.js";
import { type RuntimeEnv } from "../runtime.js";
import { getTelegramSequentialKey } from "./sequential-key.js";
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
    /** Signal to abort in-flight Telegram API fetch requests (e.g. getUpdates) on shutdown. */
    fetchAbortSignal?: AbortSignal;
    updateOffset?: {
        lastUpdateId?: number | null;
        onUpdateId?: (updateId: number) => void | Promise<void>;
    };
    testTimings?: {
        mediaGroupFlushMs?: number;
        textFragmentGapMs?: number;
    };
};
export { getTelegramSequentialKey };
export declare function createTelegramBot(opts: TelegramBotOptions): Bot<import("grammy").Context, import("grammy").Api<import("grammy").RawApi>>;
