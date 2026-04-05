import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { feishuPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(feishuPlugin);
