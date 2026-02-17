import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setBlueskyRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getBlueskyRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Bluesky runtime not initialized");
  }
  return runtime;
}
