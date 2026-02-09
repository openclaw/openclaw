import type { EasyHubPluginApi } from "../../src/plugins/types.js";
import { createLlmTaskTool } from "./src/llm-task-tool.js";

export default function register(api: EasyHubPluginApi) {
  api.registerTool(createLlmTaskTool(api), { optional: true });
}
