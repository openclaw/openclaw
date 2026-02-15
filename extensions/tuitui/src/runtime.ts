import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setTuituiRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getTuituiRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Tuitui runtime not initialized");
  }
  return runtime;
}
