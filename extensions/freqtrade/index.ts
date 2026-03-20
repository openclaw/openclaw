import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/llm-task";
import { createFreqtradeTools } from "./src/tools.js";

export default function register(api: OpenClawPluginApi) {
  const tools = createFreqtradeTools(api);
  for (const tool of tools) {
    api.registerTool(tool as unknown as AnyAgentTool, { optional: true });
  }
}
