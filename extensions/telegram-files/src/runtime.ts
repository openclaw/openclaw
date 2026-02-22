import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setFilesRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getFilesRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("telegram-files runtime not initialized");
  }
  return runtime;
}
