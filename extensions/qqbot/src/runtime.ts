import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { GatewayPluginRuntime } from "./engine/gateway/types.js";

const { setRuntime: setQQBotRuntime, getRuntime: getQQBotRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "qqbot",
    errorMessage: "QQBot runtime not initialized",
  });
export { getQQBotRuntime, setQQBotRuntime };

/** Type-narrowed getter for engine/ modules that need GatewayPluginRuntime. */
export function getQQBotRuntimeForEngine(): GatewayPluginRuntime {
  return getQQBotRuntime() as unknown as GatewayPluginRuntime;
}
