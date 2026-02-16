import type {
  AnyAgentTool,
  SmartAgentNeoPluginApi,
  SmartAgentNeoPluginToolFactory,
} from "../../src/plugins/types.js";
import { createLobsterTool } from "./src/lobster-tool.js";

export default function register(api: SmartAgentNeoPluginApi) {
  api.registerTool(
    ((ctx) => {
      if (ctx.sandboxed) {
        return null;
      }
      return createLobsterTool(api) as AnyAgentTool;
    }) as SmartAgentNeoPluginToolFactory,
    { optional: true },
  );
}
