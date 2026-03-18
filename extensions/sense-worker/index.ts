import {
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginApi,
  type OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/core";
import { createSenseWorkerTool } from "./src/tool.js";

export default definePluginEntry({
  id: "sense-worker",
  name: "Sense Worker",
  description:
    "Optional tool for offloading summarize or heavy tasks to a Sense worker node over LAN.",
  register(api: OpenClawPluginApi) {
    api.registerTool(
      ((ctx) => {
        if (ctx.sandboxed) {
          return null;
        }
        return createSenseWorkerTool(api) as AnyAgentTool;
      }) as OpenClawPluginToolFactory,
      { optional: true },
    );
  },
});
