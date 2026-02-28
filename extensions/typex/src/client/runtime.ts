/**
 * Global runtime reference for the TypeX plugin.
 */

import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setTypeXRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getTypeXRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("TypeX runtime not initialized");
  }
  return runtime;
}
