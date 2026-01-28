import type { PluginRuntime } from "clawdbot/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setKakaoRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getKakaoRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("KakaoWork runtime not initialized");
  }
  return runtime;
}
