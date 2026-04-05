import type { PluginRuntime } from "mullusi/plugin-sdk/core";
import { createPluginRuntimeStore } from "mullusi/plugin-sdk/runtime-store";

const { setRuntime: setWhatsAppRuntime, getRuntime: getWhatsAppRuntime } =
  createPluginRuntimeStore<PluginRuntime>("WhatsApp runtime not initialized");
export { getWhatsAppRuntime, setWhatsAppRuntime };
