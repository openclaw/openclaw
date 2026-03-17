import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
const { setRuntime: setTelegramRuntime, getRuntime: getTelegramRuntime } = createPluginRuntimeStore("Telegram runtime not initialized");
export {
  getTelegramRuntime,
  setTelegramRuntime
};
