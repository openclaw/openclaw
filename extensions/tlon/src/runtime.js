import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
const { setRuntime: setTlonRuntime, getRuntime: getTlonRuntime } = createPluginRuntimeStore("Tlon runtime not initialized");
export {
  getTlonRuntime,
  setTlonRuntime
};
