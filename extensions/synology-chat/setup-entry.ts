import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { synologyChatPlugin } from "./src/channel.js";
import { synologyChatSetupAdapter, synologyChatSetupWizard } from "./src/setup-surface.js";

export { synologyChatSetupAdapter, synologyChatSetupWizard } from "./src/setup-surface.js";
export default defineSetupPluginEntry(synologyChatPlugin);
