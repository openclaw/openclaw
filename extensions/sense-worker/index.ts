import {
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/core";
import { handleNemoClawCommand } from "./src/command.js";
import { createSenseWorkerHealthTool, createSenseWorkerTool } from "./src/tool.js";

export default definePluginEntry({
  id: "sense-worker",
  name: "Sense Worker",
  description:
    "Optional tool for offloading summarize or heavy tasks to a Sense worker node over LAN.",
  register(api: OpenClawPluginApi) {
    api.registerCommand({
      name: "nemoclaw",
      description: "Show the latest NemoClaw digest summary.",
      acceptsArgs: true,
      handler: async (ctx) => await handleNemoClawCommand(ctx.args),
    });
    api.registerTool(
      (ctx) => {
        if (ctx.sandboxed) {
          return null;
        }
        return createSenseWorkerTool(api) as AnyAgentTool;
      },
      { optional: true },
    );
    api.registerTool(
      (ctx) => {
        if (ctx.sandboxed) {
          return null;
        }
        return createSenseWorkerHealthTool(api) as AnyAgentTool;
      },
      { optional: true },
    );
  },
});
