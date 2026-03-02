import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { telegramUserbotPlugin } from "./src/channel.js";
import { setTelegramUserbotRuntime } from "./src/runtime.js";

const plugin = {
  id: "telegram-userbot",
  name: "Telegram Userbot",
  description: "Telegram user account channel via MTProto",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setTelegramUserbotRuntime(api.runtime);
    api.registerChannel({ plugin: telegramUserbotPlugin as ChannelPlugin });
  },
};

export default plugin;
