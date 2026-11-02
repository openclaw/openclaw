import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import { definePluginEntry } from "openclaw/plugin-sdk/core";

export function registerReefCliMetadata(api: OpenClawPluginApi) {
  api.registerCli(
    async ({ program }) => {
      const { registerReefCli } = await import("./src/cli.js");
      registerReefCli({ program });
    },
    {
      descriptors: [
        {
          name: "reef",
          description: "Register on a Reef relay and manage guarded claw-to-claw friendships",
          hasSubcommands: true,
        },
      ],
    },
  );
}

export default definePluginEntry({
  id: "reef",
  name: "Reef",
  description: "Guarded end-to-end encrypted claw channel",
  register: registerReefCliMetadata,
});
