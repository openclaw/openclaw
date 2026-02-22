import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setSimplexRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getSimplexRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("SimpleX runtime not initialized");
  }
  return runtime;
}
