import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { bluebubblesPlugin } from "./src/channel.js";
import { setBlueBubblesRuntime } from "./src/runtime.js";

export { bluebubblesPlugin } from "./src/channel.js";
export { setBlueBubblesRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "bluebubbles",
  name: "BlueBubbles",
  description: "BlueBubbles channel plugin (macOS app)",
  plugin: bluebubblesPlugin,
  setRuntime: setBlueBubblesRuntime,
});
