import type { Bot } from "grammy";
import type { OpenClawConfig, ReplyToMode, TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { TelegramBotOptions } from "./bot.js";
import type { TelegramStreamMode } from "./bot/types.js";
export declare function pruneStickerMediaFromContext(ctxPayload: {
    MediaPath?: string;
    MediaUrl?: string;
    MediaType?: string;
    MediaPaths?: string[];
    MediaUrls?: string[];
    MediaTypes?: string[];
}, opts?: {
    stickerMediaIncluded?: boolean;
}): void;
type DispatchTelegramMessageParams = {
    context: TelegramMessageContext;
    bot: Bot;
    cfg: OpenClawConfig;
    runtime: RuntimeEnv;
    replyToMode: ReplyToMode;
    streamMode: TelegramStreamMode;
    textLimit: number;
    telegramCfg: TelegramAccountConfig;
    opts: Pick<TelegramBotOptions, "token">;
};
export declare const dispatchTelegramMessage: ({ context, bot, cfg, runtime, replyToMode, streamMode, textLimit, telegramCfg, opts, }: DispatchTelegramMessageParams) => Promise<void>;
export {};
