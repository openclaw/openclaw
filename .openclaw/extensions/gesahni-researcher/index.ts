import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createGesahniResearcherTools } from "./src/tools.js";

export default function register(api: OpenClawPluginApi) {
  for (const tool of createGesahniResearcherTools(api)) {
    api.registerTool(tool, { optional: true });
  }
}
