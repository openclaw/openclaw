import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setGoHighLevelRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getGoHighLevelRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("GoHighLevel runtime not initialized");
  }
  return runtime;
}
