import type { LookupFn, PinnedDispatcherPolicy, SsrFPolicy } from "../infra/net/ssrf.js";
import { type RetryOptions } from "../infra/retry.js";
import { type SavedMedia } from "./store.js";
export declare const DEFAULT_FETCH_MEDIA_MAX_BYTES: number;
type FetchMediaResult = {
    buffer: Buffer;
    contentType?: string;
    fileName?: string;
};
export type SavedRemoteMedia = SavedMedia & {
    fileName?: string;
};
export type MediaFetchErrorCode = "max_bytes" | "http_error" | "fetch_failed";
export type MediaFetchRetryOptions = RetryOptions;
export declare class MediaFetchError extends Error {
    readonly code: MediaFetchErrorCode;
    readonly status?: number;
    constructor(code: MediaFetchErrorCode, message: string, options?: {
        cause?: unknown;
        status?: number;
    });
}
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type FetchDispatcherAttempt = {
    dispatcherPolicy?: PinnedDispatcherPolicy;
    lookupFn?: LookupFn;
};
type FetchMediaOptions = {
    url: string;
    fetchImpl?: FetchLike;
    requestInit?: RequestInit;
    filePathHint?: string;
    maxBytes?: number;
    maxRedirects?: number;
    /** Abort the guarded fetch request if it has not completed by this deadline (ms). */
    timeoutMs?: number;
    /** Abort if the response body stops yielding data for this long (ms). */
    readIdleTimeoutMs?: number;
    ssrfPolicy?: SsrFPolicy;
    lookupFn?: LookupFn;
    dispatcherPolicy?: PinnedDispatcherPolicy;
    dispatcherAttempts?: FetchDispatcherAttempt[];
    shouldRetryFetchError?: (error: unknown) => boolean;
    /**
     * Retries the complete guarded fetch/read-or-save operation. Dispatcher
     * attempts still run inside each retry attempt.
     */
    retry?: MediaFetchRetryOptions;
    /**
     * Allow an operator-configured explicit proxy to resolve target DNS after
     * hostname-policy checks instead of forcing local pinned-DNS first.
     */
    trustExplicitProxyDns?: boolean;
};
export type SaveResponseMediaOptions = {
    sourceUrl?: string;
    filePathHint?: string;
    maxBytes?: number;
    readIdleTimeoutMs?: number;
    fallbackContentType?: string;
    subdir?: string;
    originalFilename?: string;
};
export type SaveRemoteMediaOptions = FetchMediaOptions & {
    fallbackContentType?: string;
    subdir?: string;
    originalFilename?: string;
};
export declare function saveResponseMedia(res: Response, options?: SaveResponseMediaOptions): Promise<SavedRemoteMedia>;
export declare function saveRemoteMedia(options: SaveRemoteMediaOptions): Promise<SavedRemoteMedia>;
export declare function readRemoteMediaBuffer(options: FetchMediaOptions): Promise<FetchMediaResult>;
/** @deprecated Use `readRemoteMediaBuffer` for buffer reads or `saveRemoteMedia` for URL-to-store. */
export declare const fetchRemoteMedia: typeof readRemoteMediaBuffer;
export {};
