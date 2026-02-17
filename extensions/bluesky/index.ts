import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { blueskyPlugin } from "./src/channel.js";
import { setBlueskyRuntime } from "./src/runtime.js";

const plugin = {
  id: "bluesky",
  name: "Bluesky",
  description: "Bluesky DM channel plugin via AT Protocol",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setBlueskyRuntime(api.runtime);
    api.registerChannel({ plugin: blueskyPlugin });
  },
};

export default plugin;
