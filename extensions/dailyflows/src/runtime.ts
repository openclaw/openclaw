import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setDailyflowsRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getDailyflowsRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Dailyflows runtime not initialized");
  }
  return runtime;
}
