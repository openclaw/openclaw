import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
const { setRuntime: setSignalRuntime, getRuntime: getSignalRuntime } = createPluginRuntimeStore("Signal runtime not initialized");
export {
  getSignalRuntime,
  setSignalRuntime
};
