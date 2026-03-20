import type { HyperionRuntime } from "./lib/index.js";

let hyperionRuntime: HyperionRuntime | null = null;

/**
 * Set the global Hyperion runtime instance.
 * Called by the Hyperion plugin service on startup.
 */
export function setHyperionRuntime(runtime: HyperionRuntime): void {
  hyperionRuntime = runtime;
}

/**
 * Get the global Hyperion runtime instance.
 * Throws if the Hyperion plugin has not started yet.
 */
export function getHyperionRuntime(): HyperionRuntime {
  if (!hyperionRuntime) {
    throw new Error(
      "Hyperion runtime not initialized. Ensure the hyperion plugin is enabled and started.",
    );
  }
  return hyperionRuntime;
}

/**
 * Check if the Hyperion runtime is available (non-throwing).
 */
export function hasHyperionRuntime(): boolean {
  return hyperionRuntime !== null;
}

/**
 * Clear the global Hyperion runtime (for shutdown/testing).
 */
export function clearHyperionRuntime(): void {
  hyperionRuntime = null;
}
