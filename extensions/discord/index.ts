import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";

import { discordPlugin } from "./src/channel.js";

const plugin = {
  id: "discord",
  name: "Discord",
  description: "Discord channel plugin",
  register(api: ClawdbotPluginApi) {
    api.registerChannel({ plugin: discordPlugin });
  },
};

export default plugin;
