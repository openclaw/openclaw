import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
const { setRuntime: setFeishuRuntime, getRuntime: getFeishuRuntime } = createPluginRuntimeStore("Feishu runtime not initialized");
export {
  getFeishuRuntime,
  setFeishuRuntime
};
