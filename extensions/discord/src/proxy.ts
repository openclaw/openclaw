// @ts-nocheck
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { wrapFetchWithAbortSignal } from "../infra/fetch.js";

/**
 * Create a fetch() implementation that routes requests via an HTTP proxy.
 *
 * Notes:
 * - Safe to log the proxy URL (but avoid logging credentials if embedded).
 * - Never touches auth headers; callers should still pass Authorization normally.
 */
export function makeDiscordProxyFetch(proxyUrl: string): typeof fetch {
  const agent = new ProxyAgent(proxyUrl);
  return wrapFetchWithAbortSignal((input: RequestInfo | URL, init?: RequestInit) => {
    const base = init ? { ...init } : {};
    return undiciFetch(input, { ...base, dispatcher: agent });
  });
}
