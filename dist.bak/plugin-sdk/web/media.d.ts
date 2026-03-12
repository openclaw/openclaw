import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { type MediaKind } from "../media/constants.js";
import { optimizeImageToPng } from "../media/image-ops.js";
export type WebMediaResult = {
    buffer: Buffer;
    contentType?: string;
    kind: MediaKind;
    fileName?: string;
};
type WebMediaOptions = {
    maxBytes?: number;
    optimizeImages?: boolean;
    ssrfPolicy?: SsrFPolicy;
    /** Allowed root directories for local path reads. "any" is deprecated; prefer sandboxValidated + readFile. */
    localRoots?: readonly string[] | "any";
    /** Caller already validated the local path (sandbox/other guards); requires readFile override. */
    sandboxValidated?: boolean;
    readFile?: (filePath: string) => Promise<Buffer>;
};
export type LocalMediaAccessErrorCode = "path-not-allowed" | "invalid-root" | "invalid-file-url" | "unsafe-bypass" | "not-found" | "invalid-path" | "not-file";
export declare class LocalMediaAccessError extends Error {
    code: LocalMediaAccessErrorCode;
    constructor(code: LocalMediaAccessErrorCode, message: string, options?: ErrorOptions);
}
export declare function getDefaultLocalRoots(): readonly string[];
export declare function loadWebMedia(mediaUrl: string, maxBytesOrOptions?: number | WebMediaOptions, options?: {
    ssrfPolicy?: SsrFPolicy;
    localRoots?: readonly string[] | "any";
}): Promise<WebMediaResult>;
export declare function loadWebMediaRaw(mediaUrl: string, maxBytesOrOptions?: number | WebMediaOptions, options?: {
    ssrfPolicy?: SsrFPolicy;
    localRoots?: readonly string[] | "any";
}): Promise<WebMediaResult>;
export declare function optimizeImageToJpeg(buffer: Buffer, maxBytes: number, opts?: {
    contentType?: string;
    fileName?: string;
}): Promise<{
    buffer: Buffer;
    optimizedSize: number;
    resizeSide: number;
    quality: number;
}>;
export { optimizeImageToPng };
