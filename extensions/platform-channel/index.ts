import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { platformChannelPlugin, handlePlatformWebhookRequest } from "./src/channel.js";
import { setPlatformChannelRuntime } from "./src/runtime.js";

const plugin = {
  id: "platform-channel",
  name: "Platform Channel",
  description: "Receives messages from else-platform via HTTP, sends replies via webhook",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setPlatformChannelRuntime(api.runtime);
    api.registerChannel({ plugin: platformChannelPlugin });
    api.registerHttpHandler(handlePlatformWebhookRequest);
  },
};

export default plugin;
