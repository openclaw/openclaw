import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
const { setRuntime: setZaloRuntime, getRuntime: getZaloRuntime } = createPluginRuntimeStore("Zalo runtime not initialized");
export {
  getZaloRuntime,
  setZaloRuntime
};
