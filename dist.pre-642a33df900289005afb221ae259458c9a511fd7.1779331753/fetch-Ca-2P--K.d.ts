import { n as PinnedDispatcherPolicy, o as SsrFPolicy, t as LookupFn } from "./ssrf-skjEI_i5.js";
import { r as RetryOptions } from "./retry-CrxGEpqH.js";
import { a as SavedMedia } from "./store-B1k6BLfV.js";

//#region src/media/fetch.d.ts
declare const DEFAULT_FETCH_MEDIA_MAX_BYTES: number;
type FetchMediaResult = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
};
type SavedRemoteMedia = SavedMedia & {
  fileName?: string;
};
type MediaFetchErrorCode = "max_bytes" | "http_error" | "fetch_failed";
type MediaFetchRetryOptions = RetryOptions;
declare class MediaFetchError extends Error {
  readonly code: MediaFetchErrorCode;
  readonly status?: number;
  constructor(code: MediaFetchErrorCode, message: string, options?: {
    cause?: unknown;
    status?: number;
  });
}
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type FetchDispatcherAttempt = {
  dispatcherPolicy?: PinnedDispatcherPolicy;
  lookupFn?: LookupFn;
};
type FetchMediaOptions = {
  url: string;
  fetchImpl?: FetchLike;
  requestInit?: RequestInit;
  filePathHint?: string;
  maxBytes?: number;
  maxRedirects?: number; /** Abort the guarded fetch request if it has not completed by this deadline (ms). */
  timeoutMs?: number; /** Abort if the response body stops yielding data for this long (ms). */
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
type SaveResponseMediaOptions = {
  sourceUrl?: string;
  filePathHint?: string;
  maxBytes?: number;
  readIdleTimeoutMs?: number;
  fallbackContentType?: string;
  subdir?: string;
  originalFilename?: string;
};
type SaveRemoteMediaOptions = FetchMediaOptions & {
  fallbackContentType?: string;
  subdir?: string;
  originalFilename?: string;
};
declare function saveResponseMedia(res: Response, options?: SaveResponseMediaOptions): Promise<SavedRemoteMedia>;
declare function saveRemoteMedia(options: SaveRemoteMediaOptions): Promise<SavedRemoteMedia>;
declare function readRemoteMediaBuffer(options: FetchMediaOptions): Promise<FetchMediaResult>;
/** @deprecated Use `readRemoteMediaBuffer` for buffer reads or `saveRemoteMedia` for URL-to-store. */
declare const fetchRemoteMedia: typeof readRemoteMediaBuffer;
//#endregion
export { MediaFetchErrorCode as a, SaveResponseMediaOptions as c, readRemoteMediaBuffer as d, saveRemoteMedia as f, MediaFetchError as i, SavedRemoteMedia as l, FetchDispatcherAttempt as n, MediaFetchRetryOptions as o, saveResponseMedia as p, FetchLike as r, SaveRemoteMediaOptions as s, DEFAULT_FETCH_MEDIA_MAX_BYTES as t, fetchRemoteMedia as u };