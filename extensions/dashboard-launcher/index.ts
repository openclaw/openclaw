import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerDashboardCli } from "./src/command.js";

export default definePluginEntry({
  id: "dashboard-launcher",
  name: "Dashboard Launcher",
  description:
    "Supervise the Mission Control dashboard via `openclaw dashboard {start|stop|status|logs}`",
  register(api) {
    api.registerCli(
      ({ program }) => {
        registerDashboardCli(program);
      },
      {
        descriptors: [
          {
            name: "dashboard",
            description: "Supervise the Mission Control dashboard companion",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
