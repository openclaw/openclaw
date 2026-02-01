import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { createLobsterTool } from "./src/lobster-tool.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool(
    (ctx) => {
      if (ctx.sandboxed) {
        return null;
      }
      return createLobsterTool(api);
    },
    { optional: true },
  );
}
