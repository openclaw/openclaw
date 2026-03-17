import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/twitch";
import { twitchPlugin } from "./src/plugin.js";
import { setTwitchRuntime } from "./src/runtime.js";
import { monitorTwitchProvider } from "./src/monitor.js";
const plugin = {
  id: "twitch",
  name: "Twitch",
  description: "Twitch channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    setTwitchRuntime(api.runtime);
    api.registerChannel({ plugin: twitchPlugin });
  }
};
var twitch_default = plugin;
export {
  twitch_default as default,
  monitorTwitchProvider
};
