import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createSerpApiWebSearchProvider } from "./src/serpapi-search-provider.js";
import {
  createSerpApiAiOverviewTool,
  createSerpApiAutocompleteTool,
  createSerpApiAmazonTool,
  createSerpApiBingTool,
  createSerpApiDuckDuckGoTool,
  createSerpApiEventsTool,
  createSerpApiFacebookProfileTool,
  createSerpApiFinanceTool,
  createSerpApiFlightsTool,
  createSerpApiHotelsTool,
  createSerpApiImmersiveProductTool,
  createSerpApiJobsTool,
  createSerpApiLensTool,
  createSerpApiMapsTool,
  createSerpApiMapsReviewsTool,
  createSerpApiNewsTool,
  createSerpApiScholarTool,
  createSerpApiShoppingTool,
  createSerpApiTrendsTool,
  createSerpApiYouTubeTool,
  createSerpApiYouTubeTranscriptTool,
  createSerpApiYouTubeVideoTool,
  createSerpApiYahooTool,
} from "./src/tools/index.js";

export default definePluginEntry({
  id: "serpapi-search",
  name: "SerpApi Search",
  description:
    "1 universal search tool covering web, news, flights, hotels, maps, shopping, YouTube, scholar, finance, events and 100+ engines via SerpApi",
  register(api) {
    api.registerWebSearchProvider(createSerpApiWebSearchProvider());
    api.registerTool((ctx) => createSerpApiNewsTool(api, ctx), { name: "serpapi_news" });
    api.registerTool((ctx) => createSerpApiScholarTool(api, ctx), { name: "serpapi_scholar" });
    api.registerTool((ctx) => createSerpApiMapsTool(api, ctx), { name: "serpapi_maps" });
    api.registerTool((ctx) => createSerpApiMapsReviewsTool(api, ctx), { name: "serpapi_maps_reviews" });
    api.registerTool((ctx) => createSerpApiShoppingTool(api, ctx), { name: "serpapi_shopping" });
    api.registerTool((ctx) => createSerpApiAiOverviewTool(api, ctx), { name: "serpapi_ai_overview" });
    api.registerTool((ctx) => createSerpApiAmazonTool(api, ctx), { name: "serpapi_amazon" });
    api.registerTool((ctx) => createSerpApiBingTool(api, ctx), { name: "serpapi_bing" });
    api.registerTool((ctx) => createSerpApiDuckDuckGoTool(api, ctx), { name: "serpapi_duckduckgo" });
    api.registerTool((ctx) => createSerpApiImmersiveProductTool(api, ctx), { name: "serpapi_immersive_product" });
    api.registerTool((ctx) => createSerpApiJobsTool(api, ctx), { name: "serpapi_jobs" });
    api.registerTool((ctx) => createSerpApiLensTool(api, ctx), { name: "serpapi_lens" });
    api.registerTool((ctx) => createSerpApiYouTubeTool(api, ctx), { name: "serpapi_youtube" });
    api.registerTool((ctx) => createSerpApiYouTubeTranscriptTool(api, ctx), { name: "serpapi_youtube_transcript" });
    api.registerTool((ctx) => createSerpApiYouTubeVideoTool(api, ctx), { name: "serpapi_youtube_video" });
    api.registerTool((ctx) => createSerpApiTrendsTool(api, ctx), { name: "serpapi_trends" });
    api.registerTool((ctx) => createSerpApiFlightsTool(api, ctx), { name: "serpapi_flights" });
    api.registerTool((ctx) => createSerpApiHotelsTool(api, ctx), { name: "serpapi_hotels" });
    api.registerTool((ctx) => createSerpApiEventsTool(api, ctx), { name: "serpapi_events" });
    api.registerTool((ctx) => createSerpApiFacebookProfileTool(api, ctx), { name: "serpapi_facebook_profile" });
    api.registerTool((ctx) => createSerpApiFinanceTool(api, ctx), { name: "serpapi_finance" });
    api.registerTool((ctx) => createSerpApiYahooTool(api, ctx), { name: "serpapi_yahoo" });
    api.registerTool((ctx) => createSerpApiAutocompleteTool(api, ctx), { name: "serpapi_autocomplete" });
  },
});
