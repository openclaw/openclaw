/**
 * AsyncLocalStorage-based request context.
 *
 * Set once per hook invocation via `withContext`, read anywhere via `getContext()`.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Runtime } from "./runtime.js";

export interface RequestContext {
  accountId: string;
  runtime: Runtime;
}

const store = new AsyncLocalStorage<RequestContext>();

export function getContext(): RequestContext {
  const ctx = store.getStore();
  if (!ctx) throw new Error("No request context — withContext wrapper missing?");
  return ctx;
}

/**
 * HOC: wraps a hook handler factory so the returned handler runs inside context.
 *
 * Usage:
 *   api.on("message_received", withContext(getRuntime, createMessageReceivedHandler)(deps));
 */
export function withContext<TDeps, TEvent, TCtx extends { accountId?: string }, TResult>(
  getRuntime: (accountId?: string) => Runtime,
  createHandler: (deps: TDeps) => (event: TEvent, ctx: TCtx) => Promise<TResult>,
) {
  return (deps: TDeps) => {
    const handler = createHandler(deps);
    return (event: TEvent, ctx: TCtx) => {
      const runtime = getRuntime(ctx.accountId);
      return store.run({ accountId: ctx.accountId ?? "", runtime }, () => handler(event, ctx));
    };
  };
}
