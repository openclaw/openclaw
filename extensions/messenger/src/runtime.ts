import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setMessengerRuntime(r: PluginRuntime): void {
  runtime = r;
}

export function getMessengerRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Messenger runtime not initialized - plugin not registered");
  }
  return runtime;
}
