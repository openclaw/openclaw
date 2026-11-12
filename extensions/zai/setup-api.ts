// Z.AI setup module exposes the plugin public contract.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildZaiClaudeAgentSdkBackend } from "./cli-backend.js";

export default definePluginEntry({
  id: "zai",
  name: "Z.AI Setup",
  description: "Lightweight Z.AI setup hooks",
  register(api) {
    api.registerCliBackend(buildZaiClaudeAgentSdkBackend());
  },
});
