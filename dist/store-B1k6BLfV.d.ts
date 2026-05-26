import { x as resolvePinnedHostname } from "./ssrf-skjEI_i5.js";
import { request } from "node:http";

//#region src/media/store.d.ts
declare const MEDIA_MAX_BYTES: number;
type CleanOldMediaOptions = {
  recursive?: boolean;
  pruneEmptyDirs?: boolean;
};
type RequestImpl = typeof request;
type ResolvePinnedHostnameImpl = typeof resolvePinnedHostname;
declare function setMediaStoreNetworkDepsForTest(deps?: {
  httpRequest?: RequestImpl;
  httpsRequest?: RequestImpl;
  resolvePinnedHostname?: ResolvePinnedHostnameImpl;
}): void;
/**
 * Extract original filename from path if it matches the embedded format.
 * Pattern: {original}---{uuid}.{ext} → returns "{original}.{ext}"
 * Falls back to basename if no pattern match, or "file.bin" if empty.
 */
declare function extractOriginalFilename(filePath: string): string;
declare function getMediaDir(): string;
declare function ensureMediaDir(): Promise<string>;
declare function cleanOldMedia(ttlMs?: number, options?: CleanOldMediaOptions): Promise<void>;
type SavedMedia = {
  id: string;
  path: string;
  size: number;
  contentType?: string;
};
type SaveMediaSourceErrorCode = "invalid-path" | "not-found" | "not-file" | "path-mismatch" | "too-large";
declare class SaveMediaSourceError extends Error {
  code: SaveMediaSourceErrorCode;
  constructor(code: SaveMediaSourceErrorCode, message: string, options?: ErrorOptions);
}
declare function saveMediaSource(source: string, headers?: Record<string, string>, subdir?: string, maxBytes?: number): Promise<SavedMedia>;
declare function saveMediaBuffer(buffer: Buffer, contentType?: string, subdir?: string, maxBytes?: number, originalFilename?: string, detectionFilePathHint?: string): Promise<SavedMedia>;
declare function saveMediaStream(stream: AsyncIterable<unknown>, contentType?: string, subdir?: string, maxBytes?: number, originalFilename?: string, detectionFilePathHint?: string): Promise<SavedMedia>;
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
 *
 * Prefer readMediaBuffer when the caller needs the bytes; this path-returning
 * helper is for channel surfaces that need a stable local attachment path.
 */
declare function resolveMediaBufferPath(id: string, subdir?: string): Promise<string>;
type ReadMediaBufferResult = {
  id: string;
  path: string;
  buffer: Buffer;
  size: number;
};
declare function readMediaBuffer(id: string, subdir?: string, maxBytes?: number): Promise<ReadMediaBufferResult>;
/**
 * Deletes a file previously saved by saveMediaBuffer.
 *
 * This is used by parseMessageWithAttachments to clean up files that were
 * successfully offloaded earlier in the same request when a later attachment
 * fails validation and the entire parse is aborted, preventing orphaned files
 * from accumulating on disk ahead of the periodic TTL sweep.
 *
 * Uses a media-root handle to apply the same path-safety guards as the read
 * path while removing the file under the pinned media root.
 *
 * Errors are intentionally not suppressed — callers that want best-effort
 * cleanup should catch and discard exceptions themselves (e.g. via
 * Promise.allSettled).
 *
 * @param id     The media ID as returned by SavedMedia.id.
 * @param subdir The subdirectory the file was saved into (default "inbound").
 */
declare function deleteMediaBuffer(id: string, subdir?: "inbound"): Promise<void>;
//#endregion
export { SavedMedia as a, ensureMediaDir as c, readMediaBuffer as d, resolveMediaBufferPath as f, setMediaStoreNetworkDepsForTest as g, saveMediaStream as h, SaveMediaSourceErrorCode as i, extractOriginalFilename as l, saveMediaSource as m, ReadMediaBufferResult as n, cleanOldMedia as o, saveMediaBuffer as p, SaveMediaSourceError as r, deleteMediaBuffer as s, MEDIA_MAX_BYTES as t, getMediaDir as u };