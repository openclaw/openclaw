import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setNovaRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getNovaRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Nova runtime not initialized");
  }
  return runtime;
}
