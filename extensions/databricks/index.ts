import { definePluginEntry, type OpenClawPluginApi } from "./runtime-api.js";

export default definePluginEntry({
  id: "databricks",
  name: "Databricks",
  description: "Plugin-shipped Databricks skills bundle",
  register(_api: OpenClawPluginApi) {
    // This plugin currently ships skills only.
  },
});
