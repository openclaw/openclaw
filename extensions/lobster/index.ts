import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createLobsterTool } from "./src/lobster-tool.js";

export default definePluginEntry({
  id: "lobster",
  name: "Lobster",
  description: "Optional local shell helper tools",
  register(api) {
    api.registerTool(
      (ctx) => {
        if (ctx.sandboxed) {
          return null;
        }
        return createLobsterTool(api);
      },
      { optional: true, workspaceAccess: "execute" },
    );
  },
});
