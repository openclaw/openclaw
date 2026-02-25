import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setDchatRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getDchatRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("D-Chat runtime not initialized");
  }
  return runtime;
}
