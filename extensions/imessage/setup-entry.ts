import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { imessageSetupPlugin } from "./src/channel.setup.js";

export { imessageSetupPlugin } from "./src/channel.setup.js";

export default defineSetupPluginEntry(imessageSetupPlugin);
