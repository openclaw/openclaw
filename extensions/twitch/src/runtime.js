import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
const { setRuntime: setTwitchRuntime, getRuntime: getTwitchRuntime } = createPluginRuntimeStore("Twitch runtime not initialized");
export {
  getTwitchRuntime,
  setTwitchRuntime
};
