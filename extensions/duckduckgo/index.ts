import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/llm-task";
import { createDdgSearchTool } from "./src/ddg-search-tool.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool(createDdgSearchTool(api) as unknown as AnyAgentTool);
}
