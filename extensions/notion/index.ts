import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "notion",
  name: "Notion",
  description: "Notion shared memory and Skills over the official hosted MCP server",
  // The host owns OAuth, policy, discovery, and cleanup for the manifest's server.
  // There is no parallel client or memory store.
  register() {},
});
