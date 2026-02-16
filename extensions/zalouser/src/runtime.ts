import type { PluginRuntime } from "smart-agent-neo/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setZalouserRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getZalouserRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Zalouser runtime not initialized");
  }
  return runtime;
}
