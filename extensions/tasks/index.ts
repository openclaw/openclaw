import { createDefaultOperationsMaintenanceService } from "openclaw/plugin-sdk/operations-default";
import { defaultOperationsRuntime } from "openclaw/plugin-sdk/operations-default";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerTasksCli } from "./src/cli.js";

export default definePluginEntry({
  id: "tasks",
  name: "Tasks",
  description: "Durable task inspection and maintenance CLI",
  register(api) {
    api.registerOperationsRuntime(defaultOperationsRuntime);
    api.registerService(createDefaultOperationsMaintenanceService());
    api.registerCli(
      ({ program }) => {
        registerTasksCli(program, {
          config: api.config,
          operations: api.runtime.operations,
        });
      },
      {
        descriptors: [
          {
            name: "tasks",
            description: "Inspect durable background task state",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
