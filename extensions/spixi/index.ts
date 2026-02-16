import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { spixiPlugin } from "./src/channel.js";
import { setSpixiRuntime } from "./src/runtime.js";

const plugin = {
  id: "spixi",
  name: "Spixi",
  description: "Decentralized P2P messaging via Ixian network",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setSpixiRuntime(api.runtime);
    api.registerChannel({ plugin: spixiPlugin });
  },
};

export default plugin;
