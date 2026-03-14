import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createComputerUseTool } from "./src/computer-use-tool.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool(createComputerUseTool(api) as never, { optional: true });
}
