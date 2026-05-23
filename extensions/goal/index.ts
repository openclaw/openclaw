import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createGoalCommand } from "./src/command.js";
import { createGoalStatusTool } from "./src/tool.js";

export default definePluginEntry({
  id: "goal",
  name: "Goal",
  description: "Session-scoped goal tracking with bounded continuation turns.",
  register(api) {
    api.registerCommand(createGoalCommand(api));
    api.registerTool((ctx) => createGoalStatusTool(api, ctx), { name: "goal_status" });
  },
});
