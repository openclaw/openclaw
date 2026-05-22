import type { LookupFn, PinnedDispatcherPolicy, SsrFPolicy } from "../infra/net/ssrf.js";
export declare const DEFAULT_FETCH_MEDIA_MAX_BYTES: number;
type FetchMediaResult = {
    buffer: Buffer;
    contentType?: string;
    fileName?: string;
};
export type MediaFetchErrorCode = "max_bytes" | "http_error" | "fetch_failed";
export declare class MediaFetchError extends Error {
    readonly code: MediaFetchErrorCode;
    constructor(code: MediaFetchErrorCode, message: string, options?: {
        cause?: unknown;
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
    /** Abort if the response body stops yielding data for this long (ms). */
    readIdleTimeoutMs?: number;
    ssrfPolicy?: SsrFPolicy;
    lookupFn?: LookupFn;
    dispatcherPolicy?: PinnedDispatcherPolicy;
    dispatcherAttempts?: FetchDispatcherAttempt[];
    shouldRetryFetchError?: (error: unknown) => boolean;
    /**
     * Allow an operator-configured explicit proxy to resolve target DNS after
     * hostname-policy checks instead of forcing local pinned-DNS first.
     */
    trustExplicitProxyDns?: boolean;
};
export declare function fetchRemoteMedia(options: FetchMediaOptions): Promise<FetchMediaResult>;
export {};
