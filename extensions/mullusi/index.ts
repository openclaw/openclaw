import { definePluginEntry } from "mullusi/plugin-sdk/plugin-entry";
import type { AnyAgentTool, MullusiPluginApi, MullusiPluginToolFactory } from "./runtime-api.js";
import { createMullusiTool } from "./src/mullusi-tool.js";

export default definePluginEntry({
  id: "mullusi",
  name: "Mullusi",
  description: "Optional local shell helper tools",
  register(api: MullusiPluginApi) {
    api.registerTool(
      ((ctx) => {
        if (ctx.sandboxed) {
          return null;
        }
        return createMullusiTool(api) as AnyAgentTool;
      }) as MullusiPluginToolFactory,
      { optional: true },
    );
  },
});
