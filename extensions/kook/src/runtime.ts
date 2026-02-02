import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setKookRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getKookRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("KOOK runtime not initialized");
  }
  return runtime;
}
