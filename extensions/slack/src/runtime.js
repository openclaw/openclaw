import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
const { setRuntime: setSlackRuntime, getRuntime: getSlackRuntime } = createPluginRuntimeStore("Slack runtime not initialized");
export {
  getSlackRuntime,
  setSlackRuntime
};
