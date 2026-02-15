import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { rocketchatPlugin } from "./src/channel.js";
import { setRocketchatRuntime } from "./src/runtime.js";

const plugin = {
  id: "rocketchat",
  name: "Rocket.Chat",
  description: "Rocket.Chat channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setRocketchatRuntime(api.runtime);
    api.registerChannel({ plugin: rocketchatPlugin });
  },
};

export default plugin;
