import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { createGetDeparturesTool } from "./src/get-departures-tool.js";
import { createGetNearbyStopsTool } from "./src/get-nearby-stops-tool.js";
import { createSearchStopsTool } from "./src/search-stops-tool.js";

export default definePluginEntry({
  id: "entur",
  name: "Entur",
  description: "Norwegian public transit real-time departures (Ruter, Vy, AtB, etc.) via Entur",
  register(api) {
    api.registerTool(createSearchStopsTool(api) as AnyAgentTool);
    api.registerTool(createGetDeparturesTool(api) as AnyAgentTool);
    api.registerTool(createGetNearbyStopsTool(api) as AnyAgentTool);
  },
});
