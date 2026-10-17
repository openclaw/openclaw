import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "grok-bot-import",
  name: "Grok Bot Import",
  description: "Import complete Grok Bot recipes as ordinary Claw agents.",
  register(api) {
    api.registerCli(
      async ({ program }) => {
        const { registerGrokBotCli } = await import("./src/cli.js");
        registerGrokBotCli(program);
      },
      {
        descriptors: [
          {
            name: "grok-bot",
            description: "Discover and import Grok bots as Claws",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
