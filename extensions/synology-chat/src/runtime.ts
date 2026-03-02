/**
 * Plugin runtime singleton.
 * Stores the PluginRuntime from api.runtime (set during register()).
 * Used by channel.ts to access dispatch functions.
 */

import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setSynologyRuntime(r: PluginRuntime): void {
  runtime = r;
}

export function getSynologyRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Synology Chat runtime not initialized - plugin not registered");
  }
  return runtime;
}
