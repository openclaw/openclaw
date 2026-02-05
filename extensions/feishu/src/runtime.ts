import type { PluginRuntime } from "openclaw/plugin-sdk";

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
let runtime: PluginRuntime | null = null;

export function setFeishuRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getFeishuRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Feishu runtime not initialized");
  }
  return runtime;
}
