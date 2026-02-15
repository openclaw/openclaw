import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setCampfireRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getCampfireRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Campfire runtime not initialized");
  }
  return runtime;
}
