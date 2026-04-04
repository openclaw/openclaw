import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { signalPlugin } from "./src/channel.js";
import { setSignalRuntime } from "./src/runtime.js";

export { signalPlugin } from "./src/channel.js";
export { setSignalRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "signal",
  name: "Signal",
  description: "Signal channel plugin",
  plugin: signalPlugin,
  setRuntime: setSignalRuntime,
});
