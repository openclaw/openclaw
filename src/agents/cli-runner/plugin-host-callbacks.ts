import { AsyncLocalStorage } from "node:async_hooks";

function bindPluginHostCallbacks<T extends object>(context: T): T {
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [
      key,
      typeof value === "function"
        ? AsyncLocalStorage.bind(value as (...args: unknown[]) => unknown)
        : value,
    ]),
  ) as T;
}

/**
 * Starts a plugin execution whose host callbacks stay bound to the turn that built them.
 *
 * A warm transport is created by a session's first turn and keeps that turn's async
 * context for every callback it makes afterwards. A host assertion called from there
 * would resolve the first turn's session source scope instead of the current turn's,
 * and a refusal from that stale scope retires the current run's authority.
 */
export function executeWithBoundHostCallbacks<TContext extends object, TResult>(
  execute: (context: TContext) => TResult,
  context: TContext,
): TResult {
  return execute(bindPluginHostCallbacks(context));
}
