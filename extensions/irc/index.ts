import type { ChannelPlugin, SmartAgentNeoPluginApi } from "smart-agent-neo/plugin-sdk";
import { emptyPluginConfigSchema } from "smart-agent-neo/plugin-sdk";
import { ircPlugin } from "./src/channel.js";
import { setIrcRuntime } from "./src/runtime.js";

const plugin = {
  id: "irc",
  name: "IRC",
  description: "IRC channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: SmartAgentNeoPluginApi) {
    setIrcRuntime(api.runtime);
    api.registerChannel({ plugin: ircPlugin as ChannelPlugin });
  },
};

export default plugin;
