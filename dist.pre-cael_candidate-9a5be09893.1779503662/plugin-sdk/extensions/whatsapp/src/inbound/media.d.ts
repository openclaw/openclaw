import type { proto } from "baileys";
import { type SavedMedia } from "openclaw/plugin-sdk/media-store";
import type { createWaSocket } from "../session.js";
export declare class WhatsAppInboundMediaLimitExceededError extends Error {
    constructor(maxBytes: number);
}
export declare function downloadInboundMedia(msg: proto.IWebMessageInfo, sock: Awaited<ReturnType<typeof createWaSocket>>, maxBytes?: number): Promise<{
    saved: SavedMedia;
    mimetype?: string;
    fileName?: string;
} | undefined>;
export declare function downloadQuotedInboundMedia(msg: proto.IWebMessageInfo, sock: Awaited<ReturnType<typeof createWaSocket>>, maxBytes?: number): Promise<{
    saved: SavedMedia;
    mimetype?: string;
    fileName?: string;
} | undefined>;
