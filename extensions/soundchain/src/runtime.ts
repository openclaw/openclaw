import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setSoundChainRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getSoundChainRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("SoundChain runtime not initialized");
  }
  return runtime;
}
