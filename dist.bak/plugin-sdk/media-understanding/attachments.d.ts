import type { MsgContext } from "../auto-reply/templating.js";
import type { MediaUnderstandingAttachmentsConfig } from "../config/types.tools.js";
import type { MediaAttachment, MediaUnderstandingCapability } from "./types.js";
type MediaBufferResult = {
    buffer: Buffer;
    mime?: string;
    fileName: string;
    size: number;
};
type MediaPathResult = {
    path: string;
    cleanup?: () => Promise<void> | void;
};
export type MediaAttachmentCacheOptions = {
    localPathRoots?: readonly string[];
};
export declare function normalizeAttachments(ctx: MsgContext): MediaAttachment[];
export declare function resolveAttachmentKind(attachment: MediaAttachment): "image" | "audio" | "video" | "document" | "unknown";
export declare function isVideoAttachment(attachment: MediaAttachment): boolean;
export declare function isAudioAttachment(attachment: MediaAttachment): boolean;
export declare function isImageAttachment(attachment: MediaAttachment): boolean;
export declare function selectAttachments(params: {
    capability: MediaUnderstandingCapability;
    attachments: MediaAttachment[];
    policy?: MediaUnderstandingAttachmentsConfig;
}): MediaAttachment[];
export declare class MediaAttachmentCache {
    private readonly entries;
    private readonly attachments;
    private readonly localPathRoots;
    private canonicalLocalPathRoots?;
    constructor(attachments: MediaAttachment[], options?: MediaAttachmentCacheOptions);
    getBuffer(params: {
        attachmentIndex: number;
        maxBytes: number;
        timeoutMs: number;
    }): Promise<MediaBufferResult>;
    getPath(params: {
        attachmentIndex: number;
        maxBytes?: number;
        timeoutMs: number;
    }): Promise<MediaPathResult>;
    cleanup(): Promise<void>;
    private ensureEntry;
    private resolveLocalPath;
    private ensureLocalStat;
    private getCanonicalLocalPathRoots;
}
export {};
