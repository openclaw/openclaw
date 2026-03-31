import { definePluginEntry } from "./runtime-api.js";
import { createDatabricksSqlReadOnlyTool } from "./src/operations/sql.js";

export default definePluginEntry({
  id: "databricks",
  name: "Databricks",
  description: "Databricks read-only SQL runtime + skills bundle",
  register(api) {
    api.registerTool(createDatabricksSqlReadOnlyTool(api));
  },
});
