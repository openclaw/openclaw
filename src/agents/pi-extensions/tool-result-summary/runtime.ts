/**
 * Runtime state management for Tool Result Summary extension.
 *
 * Uses a WeakMap keyed by SessionManager to store per-session runtime state.
 */

import type { ToolResultSummaryRuntime } from "./types.js";

/**
 * Runtime state per session.
 */
const RUNTIME_REGISTRY = new WeakMap<object, ToolResultSummaryRuntime>();

/**
 * Default runtime state.
 */
function createDefaultRuntime(): ToolResultSummaryRuntime {
  return {
    initialized: false,
    entryCount: 0,
    lastCleanupAt: null,
    compactionOccurred: false,
  };
}

/**
 * Set runtime state for a session manager.
 */
export function setToolResultSummaryRuntime(
  sessionManager: unknown,
  value: ToolResultSummaryRuntime | null,
): void {
  if (!sessionManager || typeof sessionManager !== "object") {
    return;
  }

  const key = sessionManager;
  if (value === null) {
    RUNTIME_REGISTRY.delete(key);
    return;
  }

  RUNTIME_REGISTRY.set(key, value);
}

/**
 * Get runtime state for a session manager.
 * Returns default state if not set.
 */
export function getToolResultSummaryRuntime(sessionManager: unknown): ToolResultSummaryRuntime {
  if (!sessionManager || typeof sessionManager !== "object") {
    return createDefaultRuntime();
  }

  return RUNTIME_REGISTRY.get(sessionManager) ?? createDefaultRuntime();
}

/**
 * Update runtime state for a session manager.
 * Merges partial updates with existing state.
 */
export function updateToolResultSummaryRuntime(
  sessionManager: unknown,
  updates: Partial<ToolResultSummaryRuntime>,
): void {
  if (!sessionManager || typeof sessionManager !== "object") {
    return;
  }

  const current = getToolResultSummaryRuntime(sessionManager);
  RUNTIME_REGISTRY.set(sessionManager, { ...current, ...updates });
}

/**
 * Check if the extension is initialized for a session.
 */
export function isInitialized(sessionManager: unknown): boolean {
  return getToolResultSummaryRuntime(sessionManager).initialized;
}
