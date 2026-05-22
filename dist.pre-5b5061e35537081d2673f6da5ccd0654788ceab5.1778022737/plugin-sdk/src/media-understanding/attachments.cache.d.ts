import type { SsrFPolicy } from "../infra/net/ssrf.js";
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
    includeDefaultLocalPathRoots?: boolean;
    ssrfPolicy?: SsrFPolicy;
    workspaceDir?: string;
};
export declare class MediaAttachmentCache {
    private readonly entries;
    private readonly attachments;
    private readonly localPathRoots;
    private readonly ssrfPolicy;
    private readonly workspaceDir?;
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
    private readLocalBuffer;
    private resolveCanonicalLocalPath;
}
export {};
