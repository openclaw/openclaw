import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { slackSetupPlugin } from "./src/channel.setup.js";

export { slackSetupPlugin } from "./src/channel.setup.js";

export default defineSetupPluginEntry(slackSetupPlugin);
