import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { msteamsPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(msteamsPlugin);
