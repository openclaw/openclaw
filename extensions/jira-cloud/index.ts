import { definePluginEntry, type OpenClawPluginApi } from "./runtime-api.js";

export default definePluginEntry({
  id: "jira-cloud",
  name: "Jira Cloud",
  description: "Plugin-shipped Jira Cloud skills bundle",
  register(_api: OpenClawPluginApi) {
    // This plugin currently ships skills only.
  },
});
