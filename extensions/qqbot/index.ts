import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { qqbotPlugin } from "./src/channel.js";
import { setQQBotRuntime } from "./src/runtime.js";

export { qqbotPlugin } from "./src/channel.js";
export { setQQBotRuntime, getQQBotRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "qqbot",
  name: "QQ Bot",
  description: "QQ Bot channel plugin",
  plugin: qqbotPlugin as ChannelPlugin,
  setRuntime: setQQBotRuntime,
});
