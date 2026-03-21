import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { campfirePlugin } from "./src/channel.js";
import { setCampfireRuntime } from "./src/runtime.js";

export { campfirePlugin } from "./src/channel.js";
export { setCampfireRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "campfire",
  name: "Campfire",
  description: "Campfire channel plugin",
  plugin: campfirePlugin,
  setRuntime: setCampfireRuntime,
});
