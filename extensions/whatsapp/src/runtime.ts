import type { PluginRuntime } from "openclaw/plugin-sdk/whatsapp";
import { createPluginRuntimeStore } from "../../../src/plugin-sdk/runtime-store.js";

const { setRuntime: setWhatsAppRuntime, getRuntime: getWhatsAppRuntime } =
  createPluginRuntimeStore<PluginRuntime>("WhatsApp runtime not initialized");
export { getWhatsAppRuntime, setWhatsAppRuntime };
