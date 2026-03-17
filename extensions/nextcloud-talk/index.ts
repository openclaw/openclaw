import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { nextcloudTalkPlugin } from "./src/channel.js";
import { setNextcloudTalkRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "nextcloud-talk",
  name: "Nextcloud Talk",
  description: "Nextcloud Talk channel plugin",
  plugin: nextcloudTalkPlugin,
  setRuntime: setNextcloudTalkRuntime,
});
