import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { createCorememFindTool, createCorememRecentTool } from "./src/tools.ts";

export default function register(api: OpenClawPluginApi) {
  api.registerTool(createCorememRecentTool(api));
  api.registerTool(createCorememFindTool(api));
}
