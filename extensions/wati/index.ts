import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { watiPlugin } from "./src/channel.js";
import { setWatiRuntime } from "./src/runtime.js";

const plugin = {
  id: "wati",
  name: "WATI",
  description: "WATI WhatsApp Business API channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setWatiRuntime(api.runtime);
    api.registerChannel({ plugin: watiPlugin as ChannelPlugin });
  },
};

export default plugin;
