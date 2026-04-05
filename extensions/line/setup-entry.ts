import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { lineSetupPlugin } from "./src/channel.setup.js";

export { lineSetupPlugin } from "./src/channel.setup.js";

export default defineSetupPluginEntry(lineSetupPlugin);
