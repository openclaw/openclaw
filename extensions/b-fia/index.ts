import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { createAnalyzeStockTool } from "./src/tools/analyze-stock.js";
import { createFullReportTool } from "./src/tools/full-report.js";
import { createGetMarketDataTool } from "./src/tools/get-market-data.js";
import { createGetSentimentTool } from "./src/tools/get-sentiment.js";
import { createGetSignalsTool } from "./src/tools/get-signals.js";

export default definePluginEntry({
  id: "b-fia",
  name: "B-FIA Financial Intelligence",
  description:
    "Biggo Financial Intelligence Agent - orchestrates OpenBB, FinGPT, and QuantAgent for stock analysis",
  register(api) {
    api.registerTool(createAnalyzeStockTool(api) as AnyAgentTool);
    api.registerTool(createGetMarketDataTool(api) as AnyAgentTool);
    api.registerTool(createGetSentimentTool(api) as AnyAgentTool);
    api.registerTool(createGetSignalsTool(api) as AnyAgentTool);
    api.registerTool(createFullReportTool(api) as AnyAgentTool);
  },
});
