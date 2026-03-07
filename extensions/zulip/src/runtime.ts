/**
 * Zulip Runtime State
 */

import type { PluginRuntime } from "openclaw/plugin-sdk";

let zulipRuntime: PluginRuntime | null = null;

export function setZulipRuntime(runtime: PluginRuntime): void {
  zulipRuntime = runtime;
}

export function getZulipRuntime(): PluginRuntime {
  if (!zulipRuntime) {
    throw new Error("Zulip runtime not initialized");
  }
  return zulipRuntime;
}
