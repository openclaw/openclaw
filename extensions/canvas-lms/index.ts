import type { AnyAgentTool, OpenClawPluginApi } from "../../src/plugins/types.js";
import { createCanvasLmsTool } from "./src/canvas-lms-tool.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool(createCanvasLmsTool(api) as unknown as AnyAgentTool, { optional: true });
}
