import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { nextcloudTalkPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(nextcloudTalkPlugin);
