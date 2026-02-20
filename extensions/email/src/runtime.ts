import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setEmailRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getEmailRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Email runtime not initialized");
  }
  return runtime;
}
