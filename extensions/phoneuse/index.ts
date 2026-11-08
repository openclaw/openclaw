import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "phoneuse",
  name: "Phoneuse",
  description: "Operate a locally paired iPhone through the upstream Phoneuse MCP server.",
  // The manifest owns the MCP process and skill; no parallel device runtime.
  register() {},
});
