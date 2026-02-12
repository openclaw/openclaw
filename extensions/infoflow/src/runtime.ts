import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setInfoflowRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getInfoflowRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Infoflow runtime not initialized");
  }
  return runtime;
}
