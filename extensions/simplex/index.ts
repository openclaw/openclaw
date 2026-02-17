import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { simplexPlugin } from "./src/channel.js";
import { setSimplexRuntime } from "./src/runtime.js";

const plugin = {
  id: "simplex",
  name: "SimpleX Chat",
  description: "SimpleX Chat channel — zero-metadata encrypted DMs via local CLI WebSocket",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setSimplexRuntime(api.runtime);
    api.registerChannel({ plugin: simplexPlugin });
    api.logger.info("SimpleX Chat plugin registered");
  },
};

export default plugin;
