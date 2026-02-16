import type { PluginRuntime } from "smart-agent-neo/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setIrcRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getIrcRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("IRC runtime not initialized");
  }
  return runtime;
}
