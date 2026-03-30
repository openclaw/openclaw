import { request as httpRequest } from "node:http";
import { resolvePinnedHostname } from "../infra/net/ssrf.js";
export declare const MEDIA_MAX_BYTES: number;
type RequestImpl = typeof httpRequest;
type ResolvePinnedHostnameImpl = typeof resolvePinnedHostname;
export declare function setMediaStoreNetworkDepsForTest(deps?: {
    httpRequest?: RequestImpl;
    httpsRequest?: RequestImpl;
    resolvePinnedHostname?: ResolvePinnedHostnameImpl;
}): void;
/**
 * Extract original filename from path if it matches the embedded format.
 * Pattern: {original}---{uuid}.{ext} → returns "{original}.{ext}"
 * Falls back to basename if no pattern match, or "file.bin" if empty.
 */
export declare function extractOriginalFilename(filePath: string): string;
export declare function getMediaDir(): string;
export declare function ensureMediaDir(): Promise<string>;
export declare function cleanOldMedia(ttlMs?: number): Promise<void>;
export type SavedMedia = {
    id: string;
    path: string;
    size: number;
    contentType?: string;
};
export type SaveMediaSourceErrorCode = "invalid-path" | "not-found" | "not-file" | "path-mismatch" | "too-large";
export declare class SaveMediaSourceError extends Error {
    code: SaveMediaSourceErrorCode;
    constructor(code: SaveMediaSourceErrorCode, message: string, options?: ErrorOptions);
}
export declare function saveMediaSource(source: string, headers?: Record<string, string>, subdir?: string): Promise<SavedMedia>;
export declare function saveMediaBuffer(buffer: Buffer, contentType?: string, subdir?: string, maxBytes?: number, originalFilename?: string): Promise<SavedMedia>;
export {};
