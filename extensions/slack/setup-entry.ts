import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { slackSetupPlugin } from "./src/channel.setup.js";

export { slackSetupPlugin } from "./src/channel.setup.js";

export default defineSetupPluginEntry(slackSetupPlugin);
