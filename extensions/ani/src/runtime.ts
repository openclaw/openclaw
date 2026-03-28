import type { PluginRuntime } from "./sdk-compat.js";

let runtime: PluginRuntime | null = null;

export function setAniRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getAniRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("ANI runtime not initialized");
  }
  return runtime;
}
