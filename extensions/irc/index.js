import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/irc";
import { ircPlugin } from "./src/channel.js";
import { setIrcRuntime } from "./src/runtime.js";
const plugin = {
  id: "irc",
  name: "IRC",
  description: "IRC channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    setIrcRuntime(api.runtime);
    api.registerChannel({ plugin: ircPlugin });
  }
};
var irc_default = plugin;
export {
  irc_default as default
};
