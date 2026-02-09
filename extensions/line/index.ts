import type { EasyHubPluginApi } from "EasyHub/plugin-sdk";
import { emptyPluginConfigSchema } from "EasyHub/plugin-sdk";
import { registerLineCardCommand } from "./src/card-command.js";
import { linePlugin } from "./src/channel.js";
import { setLineRuntime } from "./src/runtime.js";

const plugin = {
  id: "line",
  name: "LINE",
  description: "LINE Messaging API channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: EasyHubPluginApi) {
    setLineRuntime(api.runtime);
    api.registerChannel({ plugin: linePlugin });
    registerLineCardCommand(api);
  },
};

export default plugin;
