import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { ircPlugin } from "./src/channel.js";
import { setIrcRuntime } from "./src/runtime.js";

export { ircPlugin } from "./src/channel.js";
export { setIrcRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "irc",
  name: "IRC",
  description: "IRC channel plugin",
  plugin: ircPlugin as ChannelPlugin,
  setRuntime: setIrcRuntime,
});
