import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const REQUEST_META_KEY = Symbol.for("openclaw.beforeToolCallRequestMeta");
const requestMetaStore = resolveGlobalSingleton<
  AsyncLocalStorage<Record<string, unknown> | undefined>
>(REQUEST_META_KEY, () => new AsyncLocalStorage());

/**
 * Request metadata the before_tool_call pipeline authored for the current
 * tool execution, or undefined when none was produced. Model-supplied `_meta`
 * never reaches this lane: it stays an ordinary tool argument.
 */
export function getBeforeToolCallRequestMeta(): Record<string, unknown> | undefined {
  return requestMetaStore.getStore();
}

/**
 * Binds the explicit `requestMeta` a hook pipeline returned on its result to
 * one tool execution. Authorship is the hook's declaration, never a value
 * comparison against params. Always enters the store — even when nothing was
 * authored — so a nested execution can never inherit an outer invocation's
 * metadata.
 */
export function runWithHookAuthoredMeta<T>(
  meta: Record<string, unknown> | undefined,
  run: () => T,
): T {
  return requestMetaStore.run(meta, run);
}
