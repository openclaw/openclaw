import type { OpenClawPluginApi } from "openclaw/plugin-sdk/discord";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/discord";
import { discordPlugin } from "./src/channel.js";
import { setDiscordRuntime } from "./src/runtime.js";
import { registerDiscordSubagentHooks } from "./src/subagent-hooks.js";

const plugin = {
  id: "discord",
  name: "Discord",
  description: "Discord channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setDiscordRuntime(api.runtime);
    api.registerChannel({ plugin: discordPlugin });
    if (api.registrationMode !== "full") {
      return;
    }
    registerDiscordSubagentHooks(api);
  },
};

export default plugin;
