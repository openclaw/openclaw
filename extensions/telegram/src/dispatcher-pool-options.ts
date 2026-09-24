// Telegram plugin module implements dispatcher pool options behavior.
import type { Agent } from "undici/index.js";
import { TELEGRAM_CLIENT_TIMEOUT_BACKSTOP_SECONDS } from "./request-timeouts.js";

// Dispatcher defaults that bound the per-origin connection pool. Telegram long
// polling keeps a handful of connections hot for hours, so the defaults must be
// strict enough that (a) idle sockets are closed even when the pool is still
// actively used and (b) the pool itself cannot grow unbounded under transient
// concurrency spikes. These values are a defence-in-depth layer; the primary
// fix for the leak observed in openclaw#68128 is the transport lifecycle that
// calls `close()` on abandoned dispatchers.
const TELEGRAM_DISPATCHER_KEEP_ALIVE_TIMEOUT_MS = 30_000;
const TELEGRAM_DISPATCHER_KEEP_ALIVE_MAX_TIMEOUT_MS = 600_000;
const TELEGRAM_DISPATCHER_CONNECTIONS_PER_ORIGIN = 10;
export const TELEGRAM_DISPATCHER_PIPELINING = 1;

export function telegramAgentPoolOptions(pipelining: 0 | 1) {
  return {
    allowH2: false,
    keepAliveTimeout: TELEGRAM_DISPATCHER_KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: TELEGRAM_DISPATCHER_KEEP_ALIVE_MAX_TIMEOUT_MS,
    connections: TELEGRAM_DISPATCHER_CONNECTIONS_PER_ORIGIN,
    pipelining,
    // undici gives up on response headers 300 s after the request body is
    // sent. A self-hosted Bot API server answers an upload only after relaying
    // the file to Telegram, so leave the deadline to the per-method guard in
    // createTelegramClientFetch (up to 30 minutes for uploads).
    headersTimeout: TELEGRAM_CLIENT_TIMEOUT_BACKSTOP_SECONDS * 1000,
  } satisfies ConstructorParameters<typeof Agent>[0];
}
