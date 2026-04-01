import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildOstkCliBackend } from "./cli-backend.js";

export default definePluginEntry({
  id: "ostk",
  name: "ostk kernel backend",
  description:
    "Run agent sessions through the ostk kernel with compiled context, session journals, and pin-enforced capabilities",
  register(api) {
    api.registerCliBackend(buildOstkCliBackend());
  },
});
