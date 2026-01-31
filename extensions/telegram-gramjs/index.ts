import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { telegramGramJSPlugin } from "./src/channel.js";

const plugin = {
  id: "telegram-gramjs",
  name: "Telegram (GramJS User Account)",
  description: "Telegram user account adapter using GramJS/MTProto",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: telegramGramJSPlugin });
  },
};

export default plugin;
