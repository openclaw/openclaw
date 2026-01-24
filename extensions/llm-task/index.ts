import type { ClawdbotPluginApi } from "../../src/plugins/types.js";

import { createLlmTaskTool } from "./src/llm-task-tool.js";

export default function register(api: ClawdbotPluginApi) {
  api.registerTool(createLlmTaskTool(api), { optional: true });
}
