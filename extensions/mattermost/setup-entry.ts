import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { mattermostPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(mattermostPlugin);
