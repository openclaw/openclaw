import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
const { setRuntime: setIMessageRuntime, getRuntime: getIMessageRuntime } = createPluginRuntimeStore("iMessage runtime not initialized");
export {
  getIMessageRuntime,
  setIMessageRuntime
};
