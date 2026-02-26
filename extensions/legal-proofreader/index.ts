import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createStage1Tool } from "./src/tools/stage1-tool.js";
import { createStage2Tool } from "./src/tools/stage2-tool.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool(createStage1Tool(api), { optional: true });
  api.registerTool(createStage2Tool(api), { optional: true });
}
