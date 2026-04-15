/**
 * Request-level context using AsyncLocalStorage.
 *
 * Provides ambient context (accountId, target openid, etc.) throughout
 * the request lifecycle without explicit parameter threading.
 *
 * This is a pure Node.js module with zero framework dependencies,
 * making it trivially portable between the built-in and standalone versions.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Context values available during one inbound message handling cycle. */
export interface RequestContext {
  /** The account ID handling this request. */
  accountId: string;
  /** The target openid (C2C) or group openid (group). */
  targetId?: string;
  /** Chat type. */
  chatType?: "c2c" | "group" | "channel" | "dm";
}

const store = new AsyncLocalStorage<RequestContext>();

/**
 * Execute an async function with request-scoped context.
 *
 * All code running within `fn` (including nested async calls) can
 * retrieve the context via `getRequestContext()`.
 *
 * @param ctx - The context to attach to this request.
 * @param fn - The async function to run within the context.
 * @returns The return value of `fn`.
 */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return store.run(ctx, fn);
}

/**
 * Retrieve the current request context.
 *
 * Returns `undefined` when called outside of a `runWithRequestContext` scope.
 */
export function getRequestContext(): RequestContext | undefined {
  return store.getStore();
}
