import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "statsig",
  name: "Statsig",
  description: "Feature gates and experiment data through Statsig's official MCP service.",
  register() {},
});
