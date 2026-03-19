import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { smsPlugin } from "./src/channel.js";
import { setSmsRuntime } from "./src/runtime.js";

export { smsPlugin } from "./src/channel.js";
export { setSmsRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "sms",
  name: "SMS",
  description: "SMS channel plugin via Quo (OpenPhone)",
  plugin: smsPlugin,
  setRuntime: setSmsRuntime,
});
