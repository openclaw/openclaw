import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";

import { signalPlugin } from "./src/channel.js";

const plugin = {
  id: "signal",
  name: "Signal",
  description: "Signal channel plugin",
  register(api: ClawdbotPluginApi) {
    api.registerChannel({ plugin: signalPlugin });
  },
};

export default plugin;
