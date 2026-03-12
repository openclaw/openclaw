import { type Bot } from "grammy";
import { type ChunkMode } from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ReplyToMode } from "../../config/config.js";
import type { MarkdownTableMode } from "../../config/types.base.js";
import type { RuntimeEnv } from "../../runtime.js";
import { type TelegramThreadSpec } from "./helpers.js";
import type { StickerMetadata, TelegramContext } from "./types.js";
export declare function deliverReplies(params: {
    replies: ReplyPayload[];
    chatId: string;
    token: string;
    runtime: RuntimeEnv;
    bot: Bot;
    mediaLocalRoots?: readonly string[];
    replyToMode: ReplyToMode;
    textLimit: number;
    thread?: TelegramThreadSpec | null;
    tableMode?: MarkdownTableMode;
    chunkMode?: ChunkMode;
    /** Callback invoked before sending a voice message to switch typing indicator. */
    onVoiceRecording?: () => Promise<void> | void;
    /** Controls whether link previews are shown. Default: true (previews enabled). */
    linkPreview?: boolean;
    /** Optional quote text for Telegram reply_parameters. */
    replyQuoteText?: string;
}): Promise<{
    delivered: boolean;
}>;
export declare function resolveMedia(ctx: TelegramContext, maxBytes: number, token: string, proxyFetch?: typeof fetch): Promise<{
    path: string;
    contentType?: string;
    placeholder: string;
    stickerMetadata?: StickerMetadata;
} | null>;
