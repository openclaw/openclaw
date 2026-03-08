import type { PluginRuntime } from "openclaw/plugin-sdk/lanxin";

let runtime: PluginRuntime | null = null;

export function setLanxinRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getLanxinRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Lanxin runtime not initialized");
  }
  return runtime;
}
