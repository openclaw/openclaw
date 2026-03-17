import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
const { setRuntime: setGoogleChatRuntime, getRuntime: getGoogleChatRuntime } = createPluginRuntimeStore("Google Chat runtime not initialized");
export {
  getGoogleChatRuntime,
  setGoogleChatRuntime
};
