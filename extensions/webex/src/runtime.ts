import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setWebexRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getWebexRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Webex runtime not initialized");
  }
  return runtime;
}
