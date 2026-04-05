import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { ircPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(ircPlugin);
