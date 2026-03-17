import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
const { setRuntime: setSynologyRuntime, getRuntime: getSynologyRuntime } = createPluginRuntimeStore(
  "Synology Chat runtime not initialized - plugin not registered"
);
export {
  getSynologyRuntime,
  setSynologyRuntime
};
