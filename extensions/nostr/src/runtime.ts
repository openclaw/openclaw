import type { PluginRuntime } from "openclaw/plugin-sdk/compat";

let runtime: PluginRuntime | null = null;

export function setNostrRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getNostrRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Nostr runtime not initialized");
  }
  return runtime;
}
