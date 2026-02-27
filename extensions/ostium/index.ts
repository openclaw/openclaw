import type { AnyAgentTool, OpenClawPluginApi } from "../../src/plugins/types.js";
import { createOstiumTool } from "./src/ostium-tool.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool(createOstiumTool(api) as unknown as AnyAgentTool, { optional: true });
}
