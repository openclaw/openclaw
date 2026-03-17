import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { signalPlugin } from "./src/channel.js";
import { setSignalRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "signal",
  name: "Signal",
  description: "Signal channel plugin",
  plugin: signalPlugin,
  setRuntime: setSignalRuntime,
});
