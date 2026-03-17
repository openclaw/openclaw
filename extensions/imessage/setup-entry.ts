import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { imessageSetupPlugin } from "./src/channel.setup.js";

export default defineSetupPluginEntry(imessageSetupPlugin);
