import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { evenniaPlugin } from "./src/channel.js";

export default defineChannelPluginEntry({
  id: "evennia",
  name: "Evennia",
  description: "OpenClaw channel bridge for Evennia MUD characters.",
  plugin: evenniaPlugin
});
