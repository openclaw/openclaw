import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { wechatLinuxPlugin } from "./src/channel.js";
import { setWechatLinuxRuntime } from "./src/runtime.js";
import { registerWechatLinuxSearchTools } from "./src/search-tools.js";

export { wechatLinuxPlugin } from "./src/channel.js";
export { setWechatLinuxRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "wechat-linux",
  name: "WeChat (Linux Desktop)",
  description: "WeChat Linux desktop channel plugin",
  plugin: wechatLinuxPlugin as ChannelPlugin,
  setRuntime: setWechatLinuxRuntime,
  registerFull(api) {
    registerWechatLinuxSearchTools(api);
  },
});
