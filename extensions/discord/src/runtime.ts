import {
  createPluginRuntimeStore,
  type PluginRuntime,
} from "../../../src/plugin-sdk-internal/core.js";

const { setRuntime: setDiscordRuntime, getRuntime: getDiscordRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Discord runtime not initialized");
export { getDiscordRuntime, setDiscordRuntime };
