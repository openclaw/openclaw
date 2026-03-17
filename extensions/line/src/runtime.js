import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
const { setRuntime: setLineRuntime, getRuntime: getLineRuntime } = createPluginRuntimeStore("LINE runtime not initialized - plugin not registered");
export {
  getLineRuntime,
  setLineRuntime
};
