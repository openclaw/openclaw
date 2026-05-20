import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createGesahniBuilderTools } from "./src/tools.js";

export default function register(api: OpenClawPluginApi) {
  for (const tool of createGesahniBuilderTools(api)) {
    api.registerTool(tool, { optional: true });
  }
}
