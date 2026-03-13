import type { TelegramTransport } from "../fetch.js";
import type { StickerMetadata, TelegramContext } from "./types.js";
export declare function resolveMedia(ctx: TelegramContext, maxBytes: number, token: string, transport?: TelegramTransport): Promise<{
    path: string;
    contentType?: string;
    placeholder: string;
    stickerMetadata?: StickerMetadata;
} | null>;
