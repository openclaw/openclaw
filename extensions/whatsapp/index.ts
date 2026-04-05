import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "whatsapp",
  name: "WhatsApp",
  description: "WhatsApp channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "whatsappPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setWhatsAppRuntime",
  },
});
