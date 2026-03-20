import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/whatsapp-business";

const { setRuntime: setWhatsappBusinessRuntime, getRuntime: getWhatsappBusinessRuntime } =
  createPluginRuntimeStore<PluginRuntime>(
    "WhatsApp Business runtime not initialized - plugin not registered",
  );
export { getWhatsappBusinessRuntime, setWhatsappBusinessRuntime };
