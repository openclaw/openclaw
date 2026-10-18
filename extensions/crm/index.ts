import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createCrmTools } from "./src/tools.js";

export default definePluginEntry({
  id: "crm",
  name: "CRM",
  description: "Agent tools for a self-hosted trycompai/crm instance.",
  register(api) {
    for (const tool of createCrmTools(api)) {
      api.registerTool(tool, { name: tool.name, workspaceAccess: false });
    }
  },
});
