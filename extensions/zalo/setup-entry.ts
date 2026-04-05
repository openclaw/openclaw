import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { zaloPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(zaloPlugin);
