import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk/telegram";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/telegram";
import { telegramPlugin } from "./src/channel.js";
import { setTelegramRuntime } from "./src/runtime.js";
import { registerTelegramSubagentHooks } from "./src/subagent-hooks.js";

const plugin = {
  id: "telegram",
  name: "Telegram",
  description: "Telegram channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setTelegramRuntime(api.runtime);
    api.registerChannel({ plugin: telegramPlugin as ChannelPlugin });
    registerTelegramSubagentHooks(api);
  },
};

export default plugin;
