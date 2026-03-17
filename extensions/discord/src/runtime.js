import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
const { setRuntime: setDiscordRuntime, getRuntime: getDiscordRuntime } = createPluginRuntimeStore("Discord runtime not initialized");
export {
  getDiscordRuntime,
  setDiscordRuntime
};
