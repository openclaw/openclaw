import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createCursorSdkAgentHarness } from "./harness.js";
import { registerCursorSdkProvider } from "./provider.js";

export default definePluginEntry({
  id: "cursor-sdk",
  name: "Cursor SDK",
  description: "Cursor SDK agent harness supporting local and cloud execution via @cursor/sdk.",
  register(api) {
    registerCursorSdkProvider(api);
    api.registerAgentHarness(createCursorSdkAgentHarness({ pluginConfig: api.pluginConfig }));
  },
});
