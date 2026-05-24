import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { createEvenniaCommandTool, evenniaPlugin } from "./src/channel.js";

export default defineChannelPluginEntry({
  id: "evennia",
  name: "Evennia",
  description: "OpenClaw channel bridge for Evennia MUD characters.",
  plugin: evenniaPlugin,
  registerFull(api) {
    api.registerTool(createEvenniaCommandTool(), { name: "evennia_command" });
  },
});
