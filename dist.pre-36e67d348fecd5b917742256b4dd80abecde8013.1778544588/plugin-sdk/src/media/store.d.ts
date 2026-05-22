import { request as httpRequest } from "node:http";
import { resolvePinnedHostname } from "../infra/net/ssrf.js";
export declare const MEDIA_MAX_BYTES: number;
type CleanOldMediaOptions = {
    recursive?: boolean;
    pruneEmptyDirs?: boolean;
};
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
export declare function cleanOldMedia(ttlMs?: number, options?: CleanOldMediaOptions): Promise<void>;
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
export declare function saveMediaSource(source: string, headers?: Record<string, string>, subdir?: string, maxBytes?: number): Promise<SavedMedia>;
export declare function saveMediaBuffer(buffer: Buffer, contentType?: string, subdir?: string, maxBytes?: number, originalFilename?: string): Promise<SavedMedia>;
/**
 * Resolves a media ID saved by saveMediaBuffer to its absolute physical path.
 *
 * This is the read-side counterpart to saveMediaBuffer and is used by the
 * agent runner to hydrate opaque `media://inbound/<id>` URIs written by the
 * Gateway's claim-check offload path.
 *
 * Security:
 * - Rejects IDs and subdirs containing path traversal, absolute paths, empty
 *   segments, or null bytes to prevent path injection outside the media root.
 * - Verifies the resolved path is a regular file (not a symlink or directory)
 *   before returning it, matching the write-side MEDIA_FILE_MODE policy.
 *
 * @param id      The media ID as returned by SavedMedia.id (may include
 *                extension and original-filename prefix,
 *                e.g. "photo---<uuid>.png" or "图片---<uuid>.png").
 * @param subdir  The subdirectory the file was saved into (default "inbound").
 * @returns       Absolute path to the file on disk.
 * @throws        If the ID is unsafe, the file does not exist, or is not a
 *                regular file.
 */
export declare function resolveMediaBufferPath(id: string, subdir?: string): Promise<string>;
/**
 * Deletes a file previously saved by saveMediaBuffer.
 *
 * This is used by parseMessageWithAttachments to clean up files that were
 * successfully offloaded earlier in the same request when a later attachment
 * fails validation and the entire parse is aborted, preventing orphaned files
 * from accumulating on disk ahead of the periodic TTL sweep.
 *
 * Uses resolveMediaBufferPath to apply the same path-safety guards as the
 * read path (separator checks, symlink rejection, etc.) before unlinking.
 *
 * Errors are intentionally not suppressed — callers that want best-effort
 * cleanup should catch and discard exceptions themselves (e.g. via
 * Promise.allSettled).
 *
 * @param id     The media ID as returned by SavedMedia.id.
 * @param subdir The subdirectory the file was saved into (default "inbound").
 */
export declare function deleteMediaBuffer(id: string, subdir?: "inbound"): Promise<void>;
export {};
