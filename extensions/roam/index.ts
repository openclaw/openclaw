import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { roamPlugin } from "./src/channel.js";
import { setRoamRuntime } from "./src/runtime.js";

export { roamPlugin } from "./src/channel.js";
export { setRoamRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "roam",
  name: "Roam",
  description: "Roam HQ channel plugin",
  plugin: roamPlugin,
  setRuntime: setRoamRuntime,
});
