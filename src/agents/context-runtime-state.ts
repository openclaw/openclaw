/**
 * Process-global context-window runtime state.
 * Keeps discovery loads, config backoff, and token cache reset behavior
 * shared across module reloads and runtime seams.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  MODEL_CONFIGURED_CONTEXT_TOKEN_CACHE,
  MODEL_CONTEXT_TOKEN_CACHE,
  MODEL_CONTEXT_WINDOW_CACHE,
} from "./context-cache.js";

const CONTEXT_WINDOW_RUNTIME_STATE_KEY = Symbol.for("openclaw.contextWindowRuntimeState");

type ContextWindowRuntimeState = {
  generation: number;
  loadPromise: Promise<void> | null;
  loadGeneration: number | null;
  configuredConfig: OpenClawConfig | undefined;
  configLoadFailures: number;
  nextConfigLoadAttemptAtMs: number;
};

/** Shared mutable state for context-window resolution and model discovery. */
export const CONTEXT_WINDOW_RUNTIME_STATE = (() => {
  const globalState = globalThis as typeof globalThis & {
    [CONTEXT_WINDOW_RUNTIME_STATE_KEY]?: ContextWindowRuntimeState;
  };
  if (!globalState[CONTEXT_WINDOW_RUNTIME_STATE_KEY]) {
    // Discovery is lifecycle-owned here; callers reuse the same pending load
    // promise and backoff counters instead of racing config discovery.
    globalState[CONTEXT_WINDOW_RUNTIME_STATE_KEY] = {
      generation: 0,
      loadPromise: null,
      loadGeneration: null,
      configuredConfig: undefined,
      configLoadFailures: 0,
      nextConfigLoadAttemptAtMs: 0,
    };
  }
  return globalState[CONTEXT_WINDOW_RUNTIME_STATE_KEY];
})();

/** Invalidate prepared context metadata while a replacement load is staged. */
export function beginContextWindowCacheRefresh(): void {
  CONTEXT_WINDOW_RUNTIME_STATE.generation += 1;
  CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig = undefined;
  CONTEXT_WINDOW_RUNTIME_STATE.configLoadFailures = 0;
  CONTEXT_WINDOW_RUNTIME_STATE.nextConfigLoadAttemptAtMs = 0;
}

/** Reset prepared context-window state after model config or plugin metadata changes. */
export function resetContextWindowCache(): void {
  beginContextWindowCacheRefresh();
  MODEL_CONFIGURED_CONTEXT_TOKEN_CACHE.clear();
  MODEL_CONTEXT_TOKEN_CACHE.clear();
  MODEL_CONTEXT_WINDOW_CACHE.clear();
}

/** Reset context-window runtime state and token cache for isolated tests. */
export function resetContextWindowCacheForTest(): void {
  resetContextWindowCache();
}
