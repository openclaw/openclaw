import type { PluginRuntime } from "openclaw/plugin-sdk/campfire";

let runtime: PluginRuntime | null = null;

export function setCampfireRuntime(next: PluginRuntime) {
  runtime = next;
}

export function clearCampfireRuntime(): void {
  runtime = null;
}

export function tryGetCampfireRuntime(): PluginRuntime | null {
  return runtime;
}

export function getCampfireRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Campfire runtime not initialized");
  }
  return runtime;
}
