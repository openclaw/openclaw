import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
const { setRuntime: setIrcRuntime, getRuntime: getIrcRuntime } = createPluginRuntimeStore("IRC runtime not initialized");
export {
  getIrcRuntime,
  setIrcRuntime
};
