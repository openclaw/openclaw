import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setZulipRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getZulipRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Zulip runtime not initialized");
  }
  return runtime;
}
