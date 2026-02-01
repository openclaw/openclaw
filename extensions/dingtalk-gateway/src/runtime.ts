import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setDingTalkGatewayRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getDingTalkGatewayRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("DingTalk Gateway runtime not initialized");
  }
  return runtime;
}
