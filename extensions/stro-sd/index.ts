import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { stroSdTool } from "./src/stro-tool.js";

export default definePluginEntry({
  id: "stro-sd",
  name: "San Diego STRO Licenses",
  description:
    "Look up active Short-Term Residential Occupancy (STRO) licenses issued by the City of San Diego.",
  register(api) {
    api.registerTool(stroSdTool as unknown as AnyAgentTool);
  },
});
