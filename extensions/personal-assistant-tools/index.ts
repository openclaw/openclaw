import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  createBrainstormerTool,
  createCodeGenerationTool,
  createIdeaGenerationTool,
  createMarketDataTool,
  createTrendFinderTool,
} from "./src/tools.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool(createMarketDataTool(api), { optional: true });
  api.registerTool(createIdeaGenerationTool(api), { optional: true });
  api.registerTool(createBrainstormerTool(api), { optional: true });
  api.registerTool(createCodeGenerationTool(api), { optional: true });
  api.registerTool(createTrendFinderTool(api), { optional: true });
}
