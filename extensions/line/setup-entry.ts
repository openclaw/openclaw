import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { lineSetupPlugin } from "./src/channel.setup.js";
import { lineSetupAdapter } from "./src/setup-core.js";
import { lineSetupWizard } from "./src/setup-surface.js";

export { lineSetupPlugin } from "./src/channel.setup.js";
export { lineSetupAdapter } from "./src/setup-core.js";
export { lineSetupWizard } from "./src/setup-surface.js";

export default defineSetupPluginEntry(lineSetupPlugin);
