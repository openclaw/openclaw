import type { DNAPluginApi } from "../../src/plugins/types.js";

import { createLlmTaskTool } from "./src/llm-task-tool.js";

export default function register(api: DNAPluginApi) {
  api.registerTool(createLlmTaskTool(api), { optional: true });
}
