import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// Skill Workshop moves out of core in stages. Its manifest owns the per-agent learned skill
// folder; runtime registrations move here as each core piece migrates.
export default definePluginEntry({
  id: "skill-workshop",
  name: "Skill Workshop",
  description: "Learned skills each agent saves from its own work.",
  register() {},
});
