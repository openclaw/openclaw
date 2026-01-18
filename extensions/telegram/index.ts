import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";

import { telegramPlugin } from "./src/channel.js";

const plugin = {
  id: "telegram",
  name: "Telegram",
  description: "Telegram channel plugin",
  register(api: ClawdbotPluginApi) {
    api.registerChannel({ plugin: telegramPlugin });
  },
};

export default plugin;
