import { defineSetupPluginEntry } from "mullusi/plugin-sdk/core";
import { imessageSetupPlugin } from "./src/channel.setup.js";

export { imessageSetupPlugin } from "./src/channel.setup.js";

export default defineSetupPluginEntry(imessageSetupPlugin);
