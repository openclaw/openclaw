import type { PluginRuntime } from "openclaw/plugin-sdk/dingtalk";

let runtime: PluginRuntime | null = null;

// 设置钉钉运行时 / Set DingTalk runtime
export function setDingtalkRuntime(next: PluginRuntime) {
  runtime = next;
}

// 获取钉钉运行时 / Get DingTalk runtime
export function getDingtalkRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("DingTalk runtime not initialized");
  }
  return runtime;
}
