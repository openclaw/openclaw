import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { registerSpecCommand } from "./src/command.js";

export default definePluginEntry({
  id: "spec-center",
  name: "Spec Center",
  description: "Markdown-first specs for auditable OpenClaw workflow runs.",
  register(api: OpenClawPluginApi) {
    registerSpecCommand(api);
  },
});
