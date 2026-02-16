import type { PluginRuntime } from "smart-agent-neo/plugin-sdk";

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
