// Rcs plugin entrypoint registers its OpenClaw integration.
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { rcsPlugin } from "./src/channel.js";
import { setRcsRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "rcs",
  name: "RCS",
  description: "Twilio RCS Business Messaging channel plugin for OpenClaw.",
  plugin: rcsPlugin,
  setRuntime: setRcsRuntime,
});
