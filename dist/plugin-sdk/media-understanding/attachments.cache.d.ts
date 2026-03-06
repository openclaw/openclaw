import type { MediaAttachment } from "./types.js";
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
