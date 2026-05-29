import { definePluginEntry } from "./api.js";
import { registerWorkboardGatewayMethods } from "./runtime-api.js";

export default definePluginEntry({
  id: "workboard",
  name: "Workboard",
  description: "Dashboard workboard for agent-owned issues and sessions.",
  register(api) {
    registerWorkboardGatewayMethods({ api });
  },
});
