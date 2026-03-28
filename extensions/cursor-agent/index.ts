import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildCursorAgentCliBackend } from "./cli-backend.js";

export default definePluginEntry({
  id: "cursor-agent",
  name: "Cursor Agent CLI Backend",
  description: "CLI backend for Cursor Agent (non-interactive mode)",
  register(api) {
    api.registerCliBackend(buildCursorAgentCliBackend());
  },
});
