// Feishu plugin module implements runtime behavior.
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const {
  setRuntime: setFeishuRuntime,
  getRuntime: getFeishuRuntime,
  tryGetRuntime: getOptionalFeishuRuntime,
} = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "feishu",
  errorMessage: "Feishu runtime not initialized",
});
export { getFeishuRuntime, getOptionalFeishuRuntime, setFeishuRuntime };
