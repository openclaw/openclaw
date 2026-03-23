import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { qqbotPlugin } from "./src/channel.js";
import { setQQBotRuntime } from "./src/runtime.js";
import { registerChannelTool } from "./src/tools/channel.js";
import { registerRemindTool } from "./src/tools/remind.js";

export { qqbotPlugin } from "./src/channel.js";
export { setQQBotRuntime, getQQBotRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "qqbot",
  name: "QQ Bot",
  description: "QQ Bot channel plugin",
  plugin: qqbotPlugin as ChannelPlugin,
  setRuntime: setQQBotRuntime,
  registerFull(api: OpenClawPluginApi) {
    registerChannelTool(api);
    registerRemindTool(api);
  },
});
