import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createGesahniOperatorTools } from "./src/tools.js";

export default function register(api: OpenClawPluginApi) {
  for (const tool of createGesahniOperatorTools(api)) {
    api.registerTool(tool as AnyAgentTool, { optional: true });
  }
}
