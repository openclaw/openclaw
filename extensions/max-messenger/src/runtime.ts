import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setMaxRuntime, getRuntime: getMaxRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "max-messenger",
    errorMessage: "MAX Messenger runtime not initialized",
  });

export { getMaxRuntime, setMaxRuntime };
