/**
 * Plugin runtime for WeChat MP (微信公众号) channel.
 */

import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setWeChatMPRuntime(r: PluginRuntime): void {
  runtime = r;
}

export function getWeChatMPRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("WeChat MP runtime not initialized — plugin not registered");
  }
  return runtime;
}
