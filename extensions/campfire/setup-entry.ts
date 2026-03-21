import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { campfirePlugin } from "./src/channel.js";

export default defineSetupPluginEntry(campfirePlugin);
