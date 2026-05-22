import { k as TelegramNetworkConfig } from "./types.channels-C67UBRPK.js";
import { n as PinnedDispatcherPolicy } from "./ssrf-skjEI_i5.js";
//#region extensions/telegram/src/fetch.d.ts
type TelegramDispatcherAttempt = {
  dispatcherPolicy?: PinnedDispatcherPolicy;
};
declare function shouldRetryTelegramTransportFallback(err: unknown): boolean;
type TelegramTransport = {
  fetch: typeof fetch;
  sourceFetch: typeof fetch;
  dispatcherAttempts?: TelegramDispatcherAttempt[];
  /**
   * Promote this transport to its next fallback dispatcher before the next
   * request. Returns false when no fallback path exists.
   */
  forceFallback?: (reason: string) => boolean;
  /**
   * Release all dispatchers owned by this transport and the TCP sockets they
   * hold. Safe to call multiple times; subsequent calls resolve immediately.
   *
   * Callers that pass their own `proxyFetch` own the underlying dispatcher
   * lifecycle themselves and this is effectively a no-op. Callers that let
   * this module construct the transport MUST invoke `close()` when the
   * transport is no longer needed (e.g. on polling session dispose or when
   * swapping transports after a network stall); otherwise undici keeps the
   * keep-alive sockets open indefinitely, leaking hundreds of connections
   * to api.telegram.org over long-running sessions.
   */
  close(): Promise<void>;
};
declare function resolveTelegramTransport(proxyFetch?: typeof fetch, options?: {
  network?: TelegramNetworkConfig;
}): TelegramTransport;
declare function resolveTelegramFetch(proxyFetch?: typeof fetch, options?: {
  network?: TelegramNetworkConfig;
}): typeof fetch;
//#endregion
export { shouldRetryTelegramTransportFallback as i, resolveTelegramFetch as n, resolveTelegramTransport as r, TelegramTransport as t };