import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setLineRuntime, getRuntime: getLineRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "line",
    errorMessage: "LINE runtime not initialized - plugin not registered",
  });
export { getLineRuntime, setLineRuntime };
