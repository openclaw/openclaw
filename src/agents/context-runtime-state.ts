/**
 * Process-global context-window runtime state.
 * Keeps discovery loads, config backoff, and token cache reset behavior
 * shared across module reloads and runtime seams.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { REUSED_CONTEXT_WINDOW_CACHE_STATE } from "./context-cache.js";

const CONTEXT_WINDOW_RUNTIME_STATE_KEY = Symbol.for("openclaw.contextWindowRuntimeState");

type ContextWindowRuntimeState = {
  generation: number;
  loadPromise: Promise<void> | null;
  loadGeneration: number | null;
  configuredConfig: OpenClawConfig | undefined;
  configLoadFailures: number;
  nextConfigLoadAttemptAtMs: number;
};

const globalState = globalThis as typeof globalThis & {
  [CONTEXT_WINDOW_RUNTIME_STATE_KEY]?: ContextWindowRuntimeState;
};

/** Shared mutable state for context-window resolution and model discovery. */
export const CONTEXT_WINDOW_RUNTIME_STATE = (globalState[CONTEXT_WINDOW_RUNTIME_STATE_KEY] ||= {
  generation: 0,
  loadPromise: null,
  loadGeneration: null,
  configuredConfig: undefined,
  configLoadFailures: 0,
  nextConfigLoadAttemptAtMs: 0,
});
if (!REUSED_CONTEXT_WINDOW_CACHE_STATE) {
  // Released modules kept cache maps outside this singleton. Force one fresh load
  // instead of pairing their completed marker with newly introduced empty maps.
  CONTEXT_WINDOW_RUNTIME_STATE.loadPromise = null;
  CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration = null;
}

/** Invalidate prepared context metadata while a replacement load is staged. */
export function beginContextWindowCacheRefresh(): void {
  CONTEXT_WINDOW_RUNTIME_STATE.generation += 1;
  CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig = undefined;
  CONTEXT_WINDOW_RUNTIME_STATE.configLoadFailures = 0;
  CONTEXT_WINDOW_RUNTIME_STATE.nextConfigLoadAttemptAtMs = 0;
}
