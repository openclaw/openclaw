import { definePluginEntry, type OpenClawPluginApi } from "./runtime-api.js";
import { createJiraCloudTools } from "./src/tools.js";

export default definePluginEntry({
  id: "jira-cloud",
  name: "Jira Cloud",
  description: "Jira Cloud tools and skills for issue workflows.",
  register(api: OpenClawPluginApi) {
    for (const tool of createJiraCloudTools(api)) {
      api.registerTool(tool);
    }
  },
});
