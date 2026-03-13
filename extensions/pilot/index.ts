import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk/pilot";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/pilot";
import { pilotPlugin } from "./src/channel.js";
import { setPilotRuntime } from "./src/runtime.js";
import { registerPilotTools } from "./src/tools/index.js";

const plugin = {
  id: "pilot",
  name: "Pilot Protocol",
  description: "Pilot Protocol channel plugin — P2P overlay network for autonomous agents",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setPilotRuntime(api.runtime);
    api.registerChannel({ plugin: pilotPlugin as ChannelPlugin });
    registerPilotTools(api);
  },
};

export default plugin;
