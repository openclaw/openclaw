import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolFactory,
} from "../../src/plugins/types.js";
import { createComfyGenerateTool } from "./src/comfy-generate-tool.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool(
    ((ctx) => {
      if (ctx.sandboxed) {
        return null;
      }
      return createComfyGenerateTool(api) as AnyAgentTool;
    }) as OpenClawPluginToolFactory,
    { optional: true },
  );
}
