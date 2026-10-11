/** Serializes this Gateway's native config writes with its config-loading requests. */

import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";

type CodexNativeConfigFenceOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  timeoutMessage?: string;
  abortMessage?: string;
};

const CODEX_NATIVE_CONFIG_FENCE_STATE = Symbol.for("openclaw.codexNativeConfigFenceState");

/** Acquires the per-CODEX_HOME fence and returns an idempotent release. */
export async function acquireCodexNativeConfigFence(
  key: string,
  options: CodexNativeConfigFenceOptions = {},
): Promise<() => void> {
  const state = resolveGlobalMap<string, Promise<void>>(CODEX_NATIVE_CONFIG_FENCE_STATE);
  const previous = state.get(key) ?? Promise.resolve();
  const { promise: current, resolve: resolveCurrent } = createDeferred<void>();
  state.set(key, current);
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    resolveCurrent();
    if (state.get(key) === current) {
      state.delete(key);
    }
  };
  try {
    await waitForPreviousFence(previous, options);
  } catch (error) {
    // Preserve FIFO exclusion for later waiters even though this caller leaves
    // the queue before its predecessor releases.
    void previous.then(release);
    throw error;
  }
  return release;
}

async function waitForPreviousFence(
  previous: Promise<void>,
  options: CodexNativeConfigFenceOptions,
): Promise<void> {
  if (options.signal?.aborted) {
    throw new Error(options.abortMessage ?? "Codex native config fence aborted");
  }
  if (options.timeoutMs === undefined && !options.signal) {
    await previous;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settle = (error?: Error) => {
      clearTimeout(timeout);
      timeout = undefined;
      options.signal?.removeEventListener("abort", onAbort);
      return error ? reject(error) : resolve();
    };
    const onAbort = () =>
      settle(new Error(options.abortMessage ?? "Codex native config fence aborted"));
    void previous.then(() => settle());
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(
        () => settle(new Error(options.timeoutMessage ?? "Codex native config fence timed out")),
        Math.max(1, options.timeoutMs),
      );
      timeout.unref?.();
    }
  });
}
