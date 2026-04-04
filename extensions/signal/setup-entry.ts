import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { signalSetupPlugin } from "./src/channel.setup.js";

export { signalSetupPlugin } from "./src/channel.setup.js";

export default defineSetupPluginEntry(signalSetupPlugin);
