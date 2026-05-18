import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createSerpApiWebSearchProvider } from "./src/serpapi-search-provider.js";
import { createSerpApiAiOverviewTool } from "./src/tools/ai-overview.js";
import { createSerpApiAmazonTool } from "./src/tools/amazon.js";
import { createSerpApiBingTool } from "./src/tools/bing.js";
import { createSerpApiDuckDuckGoTool } from "./src/tools/duckduckgo.js";
import { createSerpApiEventsTool } from "./src/tools/events.js";
import { createSerpApiImmersiveProductTool } from "./src/tools/immersive-product.js";
import { createSerpApiFinanceTool } from "./src/tools/finance.js";
import { createSerpApiFlightsTool } from "./src/tools/flights.js";
import { createSerpApiHotelsTool } from "./src/tools/hotels.js";
import { createSerpApiJobsTool } from "./src/tools/jobs.js";
import { createSerpApiLensTool } from "./src/tools/lens.js";
import { createSerpApiMapsTool } from "./src/tools/maps.js";
import { createSerpApiNewsTool } from "./src/tools/news.js";
import { createSerpApiScholarTool } from "./src/tools/scholar.js";
import { createSerpApiShoppingTool } from "./src/tools/shopping.js";
import { createSerpApiTrendsTool } from "./src/tools/trends.js";
import { createSerpApiYouTubeTool } from "./src/tools/youtube.js";

export default definePluginEntry({
  id: "serpapi-search",
  name: "SerpApi Search Plugin",
  description:
    "Universal search plugin covering web, news, flights, hotels, maps, shopping, YouTube, scholar, finance, events and 100+ engines via SerpApi",
  register(api) {
    api.registerWebSearchProvider(createSerpApiWebSearchProvider());
    api.registerTool((ctx) => createSerpApiNewsTool(api, ctx), { name: "serpapi_news" });
    api.registerTool((ctx) => createSerpApiScholarTool(api, ctx), { name: "serpapi_scholar" });
    api.registerTool((ctx) => createSerpApiMapsTool(api, ctx), { name: "serpapi_maps" });
    api.registerTool((ctx) => createSerpApiShoppingTool(api, ctx), { name: "serpapi_shopping" });
    api.registerTool((ctx) => createSerpApiAiOverviewTool(api, ctx), { name: "serpapi_ai_overview" });
    api.registerTool((ctx) => createSerpApiAmazonTool(api, ctx), { name: "serpapi_amazon" });
    api.registerTool((ctx) => createSerpApiBingTool(api, ctx), { name: "serpapi_bing" });
    api.registerTool((ctx) => createSerpApiDuckDuckGoTool(api, ctx), { name: "serpapi_duckduckgo" });
    api.registerTool((ctx) => createSerpApiImmersiveProductTool(api, ctx), { name: "serpapi_immersive_product" });
    api.registerTool((ctx) => createSerpApiJobsTool(api, ctx), { name: "serpapi_jobs" });
    api.registerTool((ctx) => createSerpApiLensTool(api, ctx), { name: "serpapi_lens" });
    api.registerTool((ctx) => createSerpApiYouTubeTool(api, ctx), { name: "serpapi_youtube" });
    api.registerTool((ctx) => createSerpApiTrendsTool(api, ctx), { name: "serpapi_trends" });
    api.registerTool((ctx) => createSerpApiFlightsTool(api, ctx), { name: "serpapi_flights" });
    api.registerTool((ctx) => createSerpApiHotelsTool(api, ctx), { name: "serpapi_hotels" });
    api.registerTool((ctx) => createSerpApiEventsTool(api, ctx), { name: "serpapi_events" });
    api.registerTool((ctx) => createSerpApiFinanceTool(api, ctx), { name: "serpapi_finance" });
  },
});
