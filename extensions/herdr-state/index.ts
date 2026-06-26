import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "herdr-state",
  name: "Herdr State Bridge",
  description:
    "Reports OpenClaw TUI idle, working, and blocked state to the containing Herdr pane.",
  register() {
    // The bridge is started by src/tui/herdr-state-sidecar.ts because only the
    // TUI process is guaranteed to inherit HERDR_PANE_ID from Herdr.
  },
});
