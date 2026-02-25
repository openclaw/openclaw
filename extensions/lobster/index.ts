import type {
  AnyAgentTool,
  ActiviPluginApi,
  ActiviPluginToolFactory,
} from "../../src/plugins/types.js";
import { createLobsterTool } from "./src/lobster-tool.js";

export default function register(api: ActiviPluginApi) {
  api.registerTool(
    ((ctx) => {
      if (ctx.sandboxed) {
        return null;
      }
      return createLobsterTool(api) as AnyAgentTool;
    }) as ActiviPluginToolFactory,
    { optional: true },
  );
}
