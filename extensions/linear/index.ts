import type { AnyAgentTool, OpenClawPluginApi } from "../../src/plugins/types.js";
import { createLinearTools } from "./src/linear-tools.js";

export default function register(api: OpenClawPluginApi) {
  const tools = createLinearTools(api);
  for (const tool of tools) {
    api.registerTool(tool as unknown as AnyAgentTool, { optional: true });
  }
}
