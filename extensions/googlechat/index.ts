import type { OpenClawPluginApi } from "openclaw/plugin-sdk/googlechat";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/googlechat";
import { googlechatPlugin } from "./src/channel.js";
import { setGoogleChatRuntime } from "./src/runtime.js";

const plugin = {
  id: "googlechat",
  name: "Google Chat",
  description: "OpenClaw Google Chat channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setGoogleChatRuntime(api.runtime);
    api.registerChannel(googlechatPlugin);
  },
};

export default plugin;
