import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { zaloPlugin } from "./src/channel.js";
import { setZaloRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "zalo",
  name: "Zalo",
  description: "Zalo channel plugin",
  plugin: zaloPlugin,
  setRuntime: setZaloRuntime,
});
