import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { vkPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(vkPlugin);
