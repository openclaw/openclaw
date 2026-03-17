import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
const { setRuntime: setWhatsAppRuntime, getRuntime: getWhatsAppRuntime } = createPluginRuntimeStore("WhatsApp runtime not initialized");
export {
  getWhatsAppRuntime,
  setWhatsAppRuntime
};
