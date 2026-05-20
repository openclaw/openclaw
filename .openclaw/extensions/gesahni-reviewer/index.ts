import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createGesahniReviewerTools } from "./src/tools.js";

export default function register(api: OpenClawPluginApi) {
  for (const tool of createGesahniReviewerTools(api)) {
    api.registerTool(tool, { optional: true });
  }
}
