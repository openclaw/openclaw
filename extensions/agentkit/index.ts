import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { AGENTKIT_CLI_DESCRIPTOR, registerAgentkitCli } from "./src/cli.js";
import { createAgentkitCommand } from "./src/command.js";
import { createAgentkitBeforeToolCallHook } from "./src/hitl.js";

export default definePluginEntry({
  id: "agentkit",
  name: "AgentKit",
  description: "World AgentKit support for human-backed delegation and World ID HITL approvals.",
  register(api) {
    api.registerCommand(createAgentkitCommand(api));
    api.on("before_tool_call", createAgentkitBeforeToolCallHook(api));
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
