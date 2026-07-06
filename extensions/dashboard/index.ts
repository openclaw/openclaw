import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerDashboardGatewayMethods } from "./src/gateway.js";
import { DashboardStore } from "./src/store.js";
import { createDashboardTools } from "./src/tools.js";

export default definePluginEntry({
  id: "dashboard",
  name: "Dashboard",
  description: "Composable dashboard workspace document and control-plane RPC backend.",
  register(api) {
    const store = new DashboardStore();
    registerDashboardGatewayMethods({ api, store });
    api.registerCli(
      async ({ program }) => {
        const { registerDashboardCli } = await import("./src/cli.js");
        registerDashboardCli({ program });
      },
      {
        descriptors: [
          {
            name: "dashboard",
            description: "Manage dashboard workspace tabs and widgets",
            hasSubcommands: true,
          },
        ],
      },
    );
    api.registerTool((context) => createDashboardTools({ api, context, store }), {
      names: [
        "dashboard_workspace_get",
        "dashboard_tab_create",
        "dashboard_tab_update",
        "dashboard_tab_delete",
        "dashboard_tabs_reorder",
        "dashboard_widget_add",
        "dashboard_widget_update",
        "dashboard_widget_move",
        "dashboard_widget_remove",
        "dashboard_layout_set",
        "dashboard_workspace_replace",
        "dashboard_widget_scaffold",
        "dashboard_undo",
        "dashboard_data_read",
      ],
      optional: true,
    });

    // The Workspaces Control UI tab and the custom-widget HTTP route are wired in
    // follow-up PRs; every caller shares this one store so mutations stay validated.
  },
});
