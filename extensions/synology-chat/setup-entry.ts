import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { synologyChatPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(synologyChatPlugin);
