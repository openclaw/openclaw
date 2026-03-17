import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/discord";
import { discordPlugin } from "./src/channel.js";
import { setDiscordRuntime } from "./src/runtime.js";
import { registerDiscordSubagentHooks } from "./src/subagent-hooks.js";
const plugin = {
  id: "discord",
  name: "Discord",
  description: "Discord channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    setDiscordRuntime(api.runtime);
    api.registerChannel({ plugin: discordPlugin });
    registerDiscordSubagentHooks(api);
  }
};
var discord_default = plugin;
export {
  discord_default as default
};
