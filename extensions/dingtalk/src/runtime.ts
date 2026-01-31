import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setDingTalkRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getDingTalkRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("DingTalk runtime not initialized");
  }
  return runtime;
}
