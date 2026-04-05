import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { nostrPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(nostrPlugin);
