import { definePluginEntry, emptyPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { createAutoReviewTool } from "./src/tool.js";

export default definePluginEntry({
  id: "autoreview",
  name: "Auto Review",
  description: "Run the installed Auto Review workflow against the current sandbox.",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    api.registerTool(
      { contextVersion: 2, create: (context) => createAutoReviewTool(context) },
      {
        name: "autoreview",
        optional: true,
        workspaceAccess: "execute",
      },
    );
  },
});
