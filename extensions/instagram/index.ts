import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { instagramPlugin } from "./src/channel.js";
import { setInstagramRuntime } from "./src/runtime.js";

const plugin = {
  id: "instagram",
  name: "Instagram",
  description: "Instagram channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setInstagramRuntime(api.runtime);
    api.registerChannel({ plugin: instagramPlugin as ChannelPlugin });
  },
};

export default plugin;
