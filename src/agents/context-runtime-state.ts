/**
 * Process-global context-window runtime state.
 * Keeps model-config loads, backoff counters, and token cache reset behavior
 * shared across module reloads and runtime seams.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createLazyImportLoader, type LazyPromiseLoader } from "../shared/lazy-promise.js";
import { MODEL_CONTEXT_TOKEN_CACHE, MODEL_CONTEXT_WINDOW_CACHE } from "./context-cache.js";

const CONTEXT_WINDOW_RUNTIME_STATE_KEY = Symbol.for("openclaw.contextWindowRuntimeState");

type ContextWindowRuntimeState = {
  generation: number;
  loadPromise: Promise<void> | null;
  loadGeneration: number | null;
  configuredConfig: OpenClawConfig | undefined;
  configLoadFailures: number;
  nextConfigLoadAttemptAtMs: number;
  modelsConfigRuntimeLoader: LazyPromiseLoader<typeof import("./models-config.runtime.js")>;
};

/** Shared mutable state for context-window resolution and model config loading. */
export const CONTEXT_WINDOW_RUNTIME_STATE = (() => {
  const globalState = globalThis as typeof globalThis & {
    [CONTEXT_WINDOW_RUNTIME_STATE_KEY]?: ContextWindowRuntimeState;
  };
  if (!globalState[CONTEXT_WINDOW_RUNTIME_STATE_KEY]) {
    // The loader is lifecycle-owned here; callers reuse the same pending load
    // promise and backoff counters instead of racing config discovery.
    globalState[CONTEXT_WINDOW_RUNTIME_STATE_KEY] = {
      generation: 0,
      loadPromise: null,
      loadGeneration: null,
      configuredConfig: undefined,
      configLoadFailures: 0,
      nextConfigLoadAttemptAtMs: 0,
      modelsConfigRuntimeLoader: createLazyImportLoader(() => import("./models-config.runtime.js")),
    };
  }
  return globalState[CONTEXT_WINDOW_RUNTIME_STATE_KEY];
})();

/** Reset prepared context-window state after model config or plugin metadata changes. */
export function resetContextWindowCache(): void {
  CONTEXT_WINDOW_RUNTIME_STATE.generation += 1;
  CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig = undefined;
  CONTEXT_WINDOW_RUNTIME_STATE.configLoadFailures = 0;
  CONTEXT_WINDOW_RUNTIME_STATE.nextConfigLoadAttemptAtMs = 0;
  MODEL_CONTEXT_TOKEN_CACHE.clear();
  MODEL_CONTEXT_WINDOW_CACHE.clear();
}

/** Reset context-window runtime state and token cache for isolated tests. */
export function resetContextWindowCacheForTest(): void {
  resetContextWindowCache();
  CONTEXT_WINDOW_RUNTIME_STATE.modelsConfigRuntimeLoader.clear();
}
