import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { qaLabGatewayDefinition } from "./src/gateway-registration.js";

export default definePluginEntry({
  ...qaLabGatewayDefinition,
  register(api) {
    qaLabGatewayDefinition.register(api);
    api.registerCli(
      async ({ program }) => {
        const { registerQaLabCli } = await import("./src/cli.js");
        registerQaLabCli(program);
      },
      {
        descriptors: [
          {
            name: "qa",
            description: "Run QA scenarios and launch the private QA debugger UI",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
