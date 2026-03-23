import type { OpenClawPluginApi, OpenClawPluginToolFactory } from "../../src/plugins/types.js";
import { createPythiaOracleTool } from "./src/tool.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool(((ctx) => createPythiaOracleTool(api, ctx)) as OpenClawPluginToolFactory);
}
