import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setA2aChannelRuntime, getRuntime: getA2aChannelRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "a2a",
    errorMessage: "A2A channel runtime not initialized",
  });

export { getA2aChannelRuntime, setA2aChannelRuntime };
