import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
 * `_meta` that the before_tool_call pipeline (trusted policies, plugin hooks,
 * finalizer) added or changed between hook input and the params that will
 * execute is transport metadata. An unchanged value — including both absent —
 * is whatever the caller supplied and is never promoted.
 */
function resolveHookAuthoredMeta(
  beforeParams: unknown,
  afterParams: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(afterParams)) {
    return undefined;
  }
  const after = afterParams._meta;
  if (!isRecord(after)) {
    return undefined;
  }
  const before = isRecord(beforeParams) ? beforeParams._meta : undefined;
  if (before !== undefined && isDeepStrictEqual(before, after)) {
    return undefined;
  }
  return after;
}

/**
 * Binds pipeline-authored request metadata to one tool execution and runs
 * `run` with it. Always enters the store — even when nothing was authored —
 * so a nested execution can never inherit an outer invocation's metadata.
 */
export function runWithHookAuthoredMeta<T>(
  beforeParams: unknown,
  afterParams: unknown,
  run: () => T,
): T {
  return requestMetaStore.run(resolveHookAuthoredMeta(beforeParams, afterParams), run);
}
