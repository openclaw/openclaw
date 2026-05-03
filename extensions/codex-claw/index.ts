import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerCodexClawCli } from "./src/cli.js";

export default definePluginEntry({
  id: "codex-claw",
  name: "Codex Claw",
  description: "Installs a Codex Desktop bridge that loads OpenClaw AGENTS.md and SOUL.md context.",
  register(api) {
    api.registerCli(registerCodexClawCli, {
      commands: ["codex-claw"],
      descriptors: [
        {
          name: "codex-claw",
          description: "Install and inspect the Codex Desktop AGENTS.md/SOUL.md bridge",
          hasSubcommands: true,
        },
      ],
    });
  },
});
