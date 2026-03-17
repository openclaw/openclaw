import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/synology-chat";
import { createSynologyChatPlugin } from "./src/channel.js";
import { setSynologyRuntime } from "./src/runtime.js";
const plugin = {
  id: "synology-chat",
  name: "Synology Chat",
  description: "Native Synology Chat channel plugin for OpenClaw",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    setSynologyRuntime(api.runtime);
    api.registerChannel({ plugin: createSynologyChatPlugin() });
  }
};
var synology_chat_default = plugin;
export {
  synology_chat_default as default
};
