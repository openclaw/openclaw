//#region src/utils/fetch-timeout.d.ts
type TimeoutAbortSignalParams = {
  timeoutMs?: number;
  signal?: AbortSignal;
  operation?: string;
  url?: string;
};
/** Returns a bound abort relay for use as an event listener. */
declare function bindAbortRelay(controller: AbortController): () => void;
declare function buildTimeoutAbortSignal(params: TimeoutAbortSignalParams): {
  signal?: AbortSignal;
  cleanup: () => void;
  refresh: () => void;
};
/**
 * Fetch wrapper that adds timeout support via AbortController.
 *
 * @param url - The URL to fetch
 * @param init - RequestInit options (headers, method, body, etc.)
 * @param timeoutMs - Timeout in milliseconds
 * @param fetchFn - The fetch implementation to use (defaults to global fetch)
 * @returns The fetch Response
 * @throws AbortError if the request times out
 */
declare function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, fetchFn?: typeof fetch): Promise<Response>;
//#endregion
export { buildTimeoutAbortSignal as n, fetchWithTimeout as r, bindAbortRelay as t };