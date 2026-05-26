import { n as PinnedDispatcherPolicy, o as SsrFPolicy, t as LookupFn } from "./ssrf-B2gz_4IH.js";

//#region src/media/fetch.d.ts
declare const DEFAULT_FETCH_MEDIA_MAX_BYTES: number;
type FetchMediaResult = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
};
type MediaFetchErrorCode = "max_bytes" | "http_error" | "fetch_failed";
declare class MediaFetchError extends Error {
  readonly code: MediaFetchErrorCode;
  constructor(code: MediaFetchErrorCode, message: string, options?: {
    cause?: unknown;
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
  maxRedirects?: number; /** Abort if the response body stops yielding data for this long (ms). */
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
declare function fetchRemoteMedia(options: FetchMediaOptions): Promise<FetchMediaResult>;
//#endregion
export { MediaFetchErrorCode as a, MediaFetchError as i, FetchDispatcherAttempt as n, fetchRemoteMedia as o, FetchLike as r, DEFAULT_FETCH_MEDIA_MAX_BYTES as t };