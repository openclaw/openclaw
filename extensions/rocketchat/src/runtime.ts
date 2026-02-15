import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setRocketchatRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getRocketchatRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Rocket.Chat runtime not initialized");
  }
  return runtime;
}
