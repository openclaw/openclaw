/** Returns a bound abort relay for use as an event listener. */
export declare function bindAbortRelay(controller: AbortController): () => void;
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
export declare function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, fetchFn?: typeof fetch): Promise<Response>;
