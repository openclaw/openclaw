import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const {
  setRuntime: setIrcRuntime,
  getRuntime: getIrcRuntime,
  tryGetRuntime: getOptionalIrcRuntime,
} = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "irc",
  errorMessage: "IRC runtime not initialized",
});
export { getIrcRuntime, getOptionalIrcRuntime, setIrcRuntime };
