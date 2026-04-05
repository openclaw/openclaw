import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { googlechatPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(googlechatPlugin);
