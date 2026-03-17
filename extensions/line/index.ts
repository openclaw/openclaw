import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { registerLineCardCommand } from "./src/card-command.js";
import { linePlugin } from "./src/channel.js";
import { setLineRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "line",
  name: "LINE",
  description: "LINE Messaging API channel plugin",
  plugin: linePlugin,
  setRuntime: setLineRuntime,
  registerFull: registerLineCardCommand,
});
