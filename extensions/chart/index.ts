import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createChartTool } from "./src/chart-tool.js";

export default definePluginEntry({
  id: "chart",
  name: "Chart Plugin",
  description: "Bundled chart generation plugin — bar, line, pie, scatter, and area charts",
  register(api) {
    api.registerTool(createChartTool());
  },
});
