import { createLlmTaskTool } from "./src/llm-task-tool.js";

export default function (api: any) {
  api.registerTool(createLlmTaskTool(api), { optional: true });
}
