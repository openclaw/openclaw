import { definePluginEntry } from "./runtime-api.js";
import { createDatabricksSqlReadOnlyTool } from "./src/operations/sql.js";

export default definePluginEntry({
  id: "databricks",
  name: "Databricks",
  description: "External Databricks read-only SQL runtime + skill pack",
  register(api) {
    api.registerTool(createDatabricksSqlReadOnlyTool(api));
  },
});
