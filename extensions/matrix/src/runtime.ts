import type { PluginRuntime } from "openclaw/plugin-sdk/compat";

let runtime: PluginRuntime | null = null;

export function setMatrixRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getMatrixRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Matrix runtime not initialized");
  }
  return runtime;
}
