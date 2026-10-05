import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// Keep the package-declared setup entry without restoring pre-July config migrations.
export default definePluginEntry({
  id: "voice-call",
  name: "Voice Call Setup",
  description: "Lightweight Voice Call setup hooks",
  register() {},
});
