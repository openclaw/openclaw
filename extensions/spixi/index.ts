import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { spixiPlugin } from "./src/channel.js";
import { SpixiRuntime, setSpixiRuntime } from "./src/runtime.js";

const plugin = {
  id: "spixi",
  name: "Spixi",
  description: "Decentralized P2P messaging via Ixian network",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setSpixiRuntime(api.runtime as SpixiRuntime);
    api.registerChannel({ plugin: spixiPlugin });
  },
};

export default plugin;
