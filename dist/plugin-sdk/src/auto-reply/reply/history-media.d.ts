import type { MsgContext } from "../templating.js";
export declare const RECENT_HISTORY_IMAGE_TTL_MS: number;
export declare const RECENT_HISTORY_IMAGE_LIMIT = 4;
export type RecentInboundHistoryImage = {
    path: string;
    contentType: string;
    sender: string;
    messageId?: string;
};
export declare function resolveRecentInboundHistoryImages(params: {
    ctx: MsgContext;
    nowMs?: number;
    ttlMs?: number;
    limit?: number;
}): RecentInboundHistoryImage[];
export declare function appendRecentHistoryImageContext(params: {
    promptText: string;
    images: RecentInboundHistoryImage[];
}): string;
