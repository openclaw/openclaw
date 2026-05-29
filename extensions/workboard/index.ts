import { definePluginEntry } from "./api.js";
import { registerWorkboardGatewayMethods } from "./runtime-api.js";
import { WorkboardStore, type PersistedWorkboardCard } from "./src/store.js";
import { createWorkboardTools } from "./src/tools.js";

export default definePluginEntry({
  id: "workboard",
  name: "Workboard",
  description: "Dashboard workboard for agent-owned issues and sessions.",
  register(api) {
    const store = WorkboardStore.open((options) =>
      api.runtime.state.openKeyedStore<PersistedWorkboardCard>(options),
    );
    registerWorkboardGatewayMethods({ api, store });
    api.registerTool((context) => createWorkboardTools({ api, context, store }), {
      names: [
        "workboard_list",
        "workboard_read",
        "workboard_claim",
        "workboard_heartbeat",
        "workboard_release",
        "workboard_comment",
        "workboard_proof",
        "workboard_unblock",
      ],
      optional: true,
    });
  },
});
