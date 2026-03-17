import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/line";
import { registerLineCardCommand } from "./src/card-command.js";
import { linePlugin } from "./src/channel.js";
import { setLineRuntime } from "./src/runtime.js";
const plugin = {
  id: "line",
  name: "LINE",
  description: "LINE Messaging API channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    setLineRuntime(api.runtime);
    api.registerChannel({ plugin: linePlugin });
    registerLineCardCommand(api);
  }
};
var line_default = plugin;
export {
  line_default as default
};
