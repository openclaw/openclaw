import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { viberPlugin } from "./src/channel.js";
import { setViberRuntime } from "./src/runtime.js";

const plugin = {
  id: "viber",
  name: "Viber",
  description: "Viber channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setViberRuntime(api.runtime);
    api.registerChannel({ plugin: viberPlugin as ChannelPlugin });
  },
};

export default plugin;
