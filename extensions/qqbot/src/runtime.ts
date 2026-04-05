import type { PluginRuntime } from "mullusi/plugin-sdk/core";
import { createPluginRuntimeStore } from "mullusi/plugin-sdk/runtime-store";

const { setRuntime: setQQBotRuntime, getRuntime: getQQBotRuntime } =
  createPluginRuntimeStore<PluginRuntime>("QQBot runtime not initialized");
export { getQQBotRuntime, setQQBotRuntime };
