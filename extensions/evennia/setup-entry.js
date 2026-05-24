import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { evenniaPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(evenniaPlugin);
