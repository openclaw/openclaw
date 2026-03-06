/**
 * Plugin runtime singleton.
 * Stores the PluginRuntime from api.runtime (set during register()).
 * Used by channel.ts to access dispatch functions.
 */

import type { PluginRuntime } from "openclaw/plugin-sdk/magicform";

let runtime: PluginRuntime | null = null;

export function setMagicFormRuntime(r: PluginRuntime): void {
  runtime = r;
}

export function getMagicFormRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("MagicForm runtime not initialized - plugin not registered");
  }
  return runtime;
}
