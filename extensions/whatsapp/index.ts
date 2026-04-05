import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { whatsappPlugin } from "./src/channel.js";
import { setWhatsAppRuntime } from "./src/runtime.js";

export { whatsappPlugin } from "./src/channel.js";
export { setWhatsAppRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "whatsapp",
  name: "WhatsApp",
  description: "WhatsApp channel plugin",
  plugin: whatsappPlugin,
  setRuntime: setWhatsAppRuntime,
});
