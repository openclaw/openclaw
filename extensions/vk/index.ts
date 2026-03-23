import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { vkPlugin } from "./src/channel.js";
import { setVkRuntime } from "./src/runtime.js";

export { vkPlugin } from "./src/channel.js";
export { setVkRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "vk",
  name: "VK",
  description: "VK channel plugin",
  plugin: vkPlugin,
  setRuntime: setVkRuntime,
});
