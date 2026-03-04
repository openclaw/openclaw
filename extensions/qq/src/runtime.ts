/**
 * Plugin runtime for QQ channel.
 */

import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setQQRuntime(r: PluginRuntime): void {
  runtime = r;
}

export function getQQRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("QQ runtime not initialized — plugin not registered");
  }
  return runtime;
}
