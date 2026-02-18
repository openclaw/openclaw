import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setKeybaseRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getKeybaseRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Keybase runtime not initialized");
  }
  return runtime;
}
