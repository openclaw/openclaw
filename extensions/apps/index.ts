import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerAppStudioGatewayMethods } from "./src/app-studio.js";

export default definePluginEntry({
  id: "apps",
  name: "Apps",
  description: "Create, validate, and prepare native apps from OpenClaw prompts.",
  register(api) {
    registerAppStudioGatewayMethods(api);
    api.registerCli(
      async ({ program }) => {
        const { registerAppsCli } = await import("./src/cli.js");
        registerAppsCli(program);
      },
      {
        descriptors: [
          {
            name: "apps",
            description: "Create, validate, and prepare native apps",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
