/**
 * Per-account client registry.
 *
 * The gateway registers a client when it starts an account, the outbound
 * path looks it up by accountId, and the gateway removes it on shutdown.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { EclawClient } from "./client.js";

const clients = new Map<string, EclawClient>();

/**
 * Active-event context.
 *
 * Tracks whether the current async execution is handling a
 * bot-to-bot (`entity_message`) or `broadcast` inbound webhook so that
 * the outbound ChannelPlugin adapter can suppress duplicate delivery
 * (the gateway has already dispatched the reply inline via sendMessage
 * + speakTo in that path).
 *
 * **Implemented via AsyncLocalStorage**, not a global per-account map,
 * so that unrelated concurrent outbound sends on the same account are
 * NOT accidentally suppressed when a bot-to-bot webhook is in flight.
 * Each webhook dispatch runs inside its own `run()` frame and only
 * outbound calls made within that frame see the suppression flag.
 */
type ActiveEventContext = { accountId: string; event: string };
const activeEventStorage = new AsyncLocalStorage<ActiveEventContext>();

export function setEclawClient(accountId: string, client: EclawClient): void {
  clients.set(accountId, client);
}

export function clearEclawClient(accountId: string): void {
  clients.delete(accountId);
}

export function getEclawClient(accountId: string): EclawClient | undefined {
  return clients.get(accountId);
}

/**
 * Run `fn` with the active-event flag bound to the current async
 * context. Outbound helpers called transitively from `fn` will see the
 * flag via `getActiveEclawEvent(accountId)`; anything running outside
 * the frame (including a concurrent `fn'` for the same accountId) will
 * not be affected.
 */
export function runWithActiveEclawEvent<T>(
  accountId: string,
  event: string,
  fn: () => Promise<T>,
): Promise<T> {
  return activeEventStorage.run({ accountId, event }, fn);
}

/** Returns the active event for `accountId` in the current async
 *  context, or `"message"` if none is set. */
export function getActiveEclawEvent(accountId: string): string {
  const ctx = activeEventStorage.getStore();
  if (!ctx || ctx.accountId !== accountId) {
    return "message";
  }
  return ctx.event;
}

/**
 * @deprecated Use `runWithActiveEclawEvent(accountId, event, fn)` instead.
 * Kept as a no-op for any external callers; the old global-map API was
 * vulnerable to concurrent-send drop (see PR #62934 review).
 */
export function setActiveEclawEvent(_accountId: string, _event: string): void {
  /* no-op: use runWithActiveEclawEvent */
}

/**
 * @deprecated Use `runWithActiveEclawEvent(accountId, event, fn)` instead.
 * Kept as a no-op for any external callers.
 */
export function clearActiveEclawEvent(_accountId: string): void {
  /* no-op: use runWithActiveEclawEvent */
}
