import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { whatsappSetupPlugin } from "./src/channel.setup.js";

export default defineSetupPluginEntry(whatsappSetupPlugin);
