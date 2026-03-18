import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { nostrPlugin } from "./src/channel.js";

export { nostrSetupAdapter, nostrSetupWizard } from "./src/setup-surface.js";
export default defineSetupPluginEntry(nostrPlugin);
