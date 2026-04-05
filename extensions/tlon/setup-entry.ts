import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { tlonPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(tlonPlugin);
