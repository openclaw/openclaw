import { createLlmTaskTool } from "./src/llm-task-tool.js";
function register(api) {
  api.registerTool(createLlmTaskTool(api), { optional: true });
}
export {
  register as default
};
