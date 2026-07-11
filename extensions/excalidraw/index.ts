import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// The Excalidraw plugin is manifest-only: enabling it attaches the official
// Excalidraw MCP App server (declared via `mcpServers` in openclaw.plugin.json)
// to agent sessions. The server's `create_view` tool carries an MCP Apps
// ui:// resource that UI-capable surfaces render as an interactive canvas;
// other surfaces receive its plain text/structured result.
export default definePluginEntry({
  id: "excalidraw",
  name: "Excalidraw",
  description: "Hand-drawn Excalidraw diagrams via the official Excalidraw MCP App server.",
  register() {
    // No runtime registration: the MCP server attachment is manifest-driven.
  },
});
