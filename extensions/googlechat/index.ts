import type { ChannelPlugin } from "mullusi/plugin-sdk/core";
import { defineChannelPluginEntry } from "mullusi/plugin-sdk/core";
import { googlechatPlugin } from "./src/channel.js";
import { setGoogleChatRuntime } from "./src/runtime.js";

export { googlechatPlugin } from "./src/channel.js";
export { setGoogleChatRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "googlechat",
  name: "Google Chat",
  description: "Mullusi Google Chat channel plugin",
  plugin: googlechatPlugin as ChannelPlugin,
  setRuntime: setGoogleChatRuntime,
});
