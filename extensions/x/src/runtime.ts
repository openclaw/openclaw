import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const store = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "x",
  errorMessage: "X runtime not initialized",
});
export const getXRuntime = store.getRuntime;
export const setXRuntime = store.setRuntime;
