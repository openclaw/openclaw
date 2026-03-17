import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { googlechatPlugin } from "./src/channel.js";
import { setGoogleChatRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "googlechat",
  name: "Google Chat",
  description: "OpenClaw Google Chat channel plugin",
  plugin: googlechatPlugin,
  setRuntime: setGoogleChatRuntime,
});
