import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { AGENTKIT_CLI_DESCRIPTOR, registerAgentkitCli } from "./src/cli.js";

export default definePluginEntry({
  id: "agentkit",
  name: "AgentKit",
  description: "World AgentKit support for human-backed delegation and World ID HITL approvals.",
  register(api) {
    api.registerCli(
      ({ program, config: appConfig }) => {
        registerAgentkitCli(program, appConfig);
      },
      {
        descriptors: [AGENTKIT_CLI_DESCRIPTOR],
      },
    );
  },
});
