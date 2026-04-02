import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { mattermostPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(mattermostPlugin);
