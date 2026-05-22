import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PromptImageOrderEntry } from "../media/prompt-image-order.js";
export type ChatAttachment = {
    type?: string;
    mimeType?: string;
    fileName?: string;
    content?: unknown;
};
export type ChatImageContent = {
    type: "image";
    data: string;
    mimeType: string;
};
export type OffloadedRef = {
    mediaRef: string;
    id: string;
    path: string;
    mimeType: string;
    label: string;
    sizeBytes: number;
};
type ParsedMessageWithImages = {
    message: string;
    images: ChatImageContent[];
    imageOrder: PromptImageOrderEntry[];
    offloadedRefs: OffloadedRef[];
};
type AttachmentLog = {
    info?: (message: string) => void;
    warn: (message: string) => void;
};
export declare const DEFAULT_CHAT_ATTACHMENT_MAX_MB = 20;
export declare function resolveChatAttachmentMaxBytes(cfg: OpenClawConfig): number;
type UnsupportedAttachmentReason = "empty-payload" | "text-only-image" | "unsupported-non-image" | "non-image-too-large-for-sandbox";
export declare class UnsupportedAttachmentError extends Error {
    readonly reason: UnsupportedAttachmentReason;
    constructor(reason: UnsupportedAttachmentReason, message: string);
}
export declare class MediaOffloadError extends Error {
    readonly cause: unknown;
    constructor(message: string, options?: ErrorOptions);
}
export declare function parseMessageWithAttachments(message: string, attachments: ChatAttachment[] | undefined, opts?: {
    maxBytes?: number;
    log?: AttachmentLog;
    supportsImages?: boolean;
    supportsInlineImages?: boolean;
    acceptNonImage?: boolean;
}): Promise<ParsedMessageWithImages>;
/**
 * @deprecated Use parseMessageWithAttachments instead.
 * This function converts images to markdown data URLs which Claude API cannot process as images.
 */
export declare function buildMessageWithAttachments(message: string, attachments: ChatAttachment[] | undefined, opts?: {
    maxBytes?: number;
}): string;
export {};
