import type { OpenClawPluginApi } from "openclaw/plugin-sdk/synology-chat";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/synology-chat";
import { synologyChatPlugin } from "./src/channel.js";
import { setSynologyRuntime } from "./src/runtime.js";

const plugin = {
  id: "synology-chat",
  name: "Synology Chat",
  description: "Native Synology Chat channel plugin for OpenClaw",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setSynologyRuntime(api.runtime);
    api.registerChannel({ plugin: synologyChatPlugin });
  },
};

export default plugin;
