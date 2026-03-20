import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/llm-task";
import { createSearxngSearchTool } from "./src/searxng-search-tool.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool(createSearxngSearchTool(api) as unknown as AnyAgentTool);
}
