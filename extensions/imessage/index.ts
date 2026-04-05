import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { imessagePlugin } from "./src/channel.js";
import { setIMessageRuntime } from "./src/runtime.js";

export { imessagePlugin } from "./src/channel.js";
export { setIMessageRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "imessage",
  name: "iMessage",
  description: "iMessage channel plugin",
  plugin: imessagePlugin,
  setRuntime: setIMessageRuntime,
});
