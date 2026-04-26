import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "orchestrator",
  name: "Fleet Orchestrator",
  description:
    "Phase B routing layer — schema, deterministic routing engine, and file-backed task store. CLI verbs and cross-repo HTTP routes land in later units.",
  register() {
    // Units 2–4 ship pure helpers consumed by later units. The CLI
    // (`openclaw orchestrator …`) and the gateway HTTP routes
    // (`/orchestrator/*`) are introduced in Units 5 and 7.
  },
});
