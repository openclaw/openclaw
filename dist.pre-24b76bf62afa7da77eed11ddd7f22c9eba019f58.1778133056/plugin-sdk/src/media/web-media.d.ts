import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { type MediaKind } from "./constants.js";
import { optimizeImageToPng } from "./image-ops.js";
import { getDefaultLocalRoots, LocalMediaAccessError, type LocalMediaAccessErrorCode } from "./local-media-access.js";
export { getDefaultLocalRoots, LocalMediaAccessError };
export type { LocalMediaAccessErrorCode };
export type WebMediaResult = {
    buffer: Buffer;
    contentType?: string;
    kind: MediaKind | undefined;
    fileName?: string;
};
type WebMediaOptions = {
    maxBytes?: number;
    optimizeImages?: boolean;
    ssrfPolicy?: SsrFPolicy;
    proxyUrl?: string;
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    requestInit?: RequestInit;
    trustExplicitProxyDns?: boolean;
    workspaceDir?: string;
    /** Allowed root directories for local path reads. "any" is deprecated; prefer sandboxValidated + readFile. */
    localRoots?: readonly string[] | "any";
    /** Caller already validated the local path (sandbox/other guards); requires readFile override. */
    sandboxValidated?: boolean;
    readFile?: (filePath: string) => Promise<Buffer>;
    /** Host-local fs-policy read piggyback; rejects plaintext-like document sends. */
    hostReadCapability?: boolean;
};
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
