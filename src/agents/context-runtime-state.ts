/**
 * Process-global context-window runtime state.
 * Keeps discovery loads and token cache reset behavior
 * shared across module reloads and runtime seams.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";

const CONTEXT_WINDOW_RUNTIME_STATE_KEY = Symbol.for("openclaw.contextWindowRuntimeState");

type ContextWindowRuntimeState = {
  loadPromise: Promise<void> | null;
  configuredConfig: OpenClawConfig | undefined;
};

const globalState = globalThis as typeof globalThis & {
  [CONTEXT_WINDOW_RUNTIME_STATE_KEY]?: ContextWindowRuntimeState;
};

/** Shared mutable state for context-window resolution and model discovery. */
export const CONTEXT_WINDOW_RUNTIME_STATE = (globalState[CONTEXT_WINDOW_RUNTIME_STATE_KEY] ||= {
  loadPromise: null,
  configuredConfig: undefined,
});

/** Invalidate prepared context metadata while a replacement load is staged. */
export function beginContextWindowCacheRefresh(): void {
  CONTEXT_WINDOW_RUNTIME_STATE.loadPromise = null;
  CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig = undefined;
}
