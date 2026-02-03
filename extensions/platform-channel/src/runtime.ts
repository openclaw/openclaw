import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setPlatformChannelRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getPlatformChannelRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("PlatformChannel runtime not initialized");
  }
  return runtime;
}
