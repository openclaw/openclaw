import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime;
let initialized = false;

export function setZulipRuntime(next: PluginRuntime) {
  runtime = next;
  initialized = true;
}

export function getZulipRuntime(): PluginRuntime {
  if (!initialized) {
    throw new Error("Zulip runtime not initialized");
  }
  return runtime;
}
