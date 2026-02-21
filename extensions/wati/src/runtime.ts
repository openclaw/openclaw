import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setWatiRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getWatiRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("WATI runtime not initialized");
  }
  return runtime;
}
