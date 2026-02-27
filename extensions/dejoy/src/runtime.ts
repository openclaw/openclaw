import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setDeJoyRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getDeJoyRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("DeJoy runtime not initialized");
  }
  return runtime;
}
