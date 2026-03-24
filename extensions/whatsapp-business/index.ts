import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { whatsappBusinessPlugin } from "./src/channel.js";
import { setWhatsappBusinessRuntime } from "./src/runtime.js";

export { whatsappBusinessPlugin } from "./src/channel.js";
export { setWhatsappBusinessRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "whatsapp-business",
  name: "WhatsApp Business",
  description: "WhatsApp Business Cloud API channel plugin via Meta",
  plugin: whatsappBusinessPlugin,
  setRuntime: setWhatsappBusinessRuntime,
});
