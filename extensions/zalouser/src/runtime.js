import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
const { setRuntime: setZalouserRuntime, getRuntime: getZalouserRuntime } = createPluginRuntimeStore("Zalouser runtime not initialized");
export {
  getZalouserRuntime,
  setZalouserRuntime
};
