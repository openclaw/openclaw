import type { OpenClawPluginApi } from "openclaw/plugin-sdk/campfire";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/campfire";
import { campfirePlugin } from "./src/channel.js";
import { setCampfireRuntime } from "./src/runtime.js";

const plugin = {
  id: "campfire",
  name: "Campfire",
  description: "OpenClaw Campfire channel plugin (37signals self-hosted chat)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setCampfireRuntime(api.runtime);
    api.registerChannel({ plugin: campfirePlugin });
  },
};

export default plugin;
