import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";

import { whatsappPlugin } from "./src/channel.js";

const plugin = {
  id: "whatsapp",
  name: "WhatsApp",
  description: "WhatsApp channel plugin",
  register(api: ClawdbotPluginApi) {
    api.registerChannel({ plugin: whatsappPlugin });
  },
};

export default plugin;
