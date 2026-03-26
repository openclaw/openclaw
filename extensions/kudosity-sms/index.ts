/**
 * Kudosity SMS channel plugin for OpenClaw.
 *
 * This is the plugin entry point — it registers the Kudosity SMS channel
 * with OpenClaw's plugin system.
 *
 * @see https://developers.kudosity.com
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { kudositySmsPlugin } from "./src/channel.js";
import { setKudositySmsRuntime } from "./src/runtime.js";

export { kudositySmsPlugin } from "./src/channel.js";
export { setKudositySmsRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "kudosity-sms",
  name: "Kudosity SMS",
  description: "Cloud SMS channel powered by Kudosity — send and receive SMS via the Kudosity API",
  plugin: kudositySmsPlugin,
  setRuntime: setKudositySmsRuntime,
});