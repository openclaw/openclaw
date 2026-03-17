import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { msteamsPlugin } from "./src/channel.js";
import { setMSTeamsRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "msteams",
  name: "Microsoft Teams",
  description: "Microsoft Teams channel plugin (Bot Framework)",
  plugin: msteamsPlugin,
  setRuntime: setMSTeamsRuntime,
});
