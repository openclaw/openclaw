import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createSerpApiWebSearchProvider } from "./src/serpapi-search-provider.ts";
import {
  createSerpApiAiOverviewTool,
  createSerpApiAutocompleteTool,
  createSerpApiAmazonTool,
  createSerpApiAmazonProductTool,
  createSerpApiBingTool,
  createSerpApiDuckDuckGoTool,
  createSerpApiEbayTool,
  createSerpApiEbayProductTool,
  createSerpApiEventsTool,
  createSerpApiFacebookProfileTool,
  createSerpApiFinanceTool,
  createSerpApiFlightsTool,
  createSerpApiHotelsTool,
  createSerpApiImmersiveProductTool,
  createSerpApiInstagramProfileTool,
  createSerpApiJobsTool,
  createSerpApiLensTool,
  createSerpApiMapsTool,
  createSerpApiMapsReviewsTool,
  createSerpApiNewsTool,
  createSerpApiScholarTool,
  createSerpApiShoppingTool,
  createSerpApiTrendsTool,
  createSerpApiTripadvisorTool,
  createSerpApiYouTubeTool,
  createSerpApiYouTubeTranscriptTool,
  createSerpApiYouTubeVideoTool,
  createSerpApiYahooTool,
  createSerpApiWeatherTool,
  createSerpApiWalmartTool,
  createSerpApiWalmartProductTool,
} from "./src/tools/index.ts";

export default definePluginEntry({
  id: "serpapi",
  name: "SerpApi Search",
  description:
    "Web search provider plus multiple specialized SerpApi tools for news, flights, hotels, maps, shopping, YouTube, scholar, finance, events, and 100+ search engines",
  register(api) {
    api.registerWebSearchProvider(createSerpApiWebSearchProvider());
    api.registerTool((ctx) => createSerpApiNewsTool(api, ctx), { name: "serpapi_news" });
    api.registerTool((ctx) => createSerpApiScholarTool(api, ctx), { name: "serpapi_scholar" });
    api.registerTool((ctx) => createSerpApiMapsTool(api, ctx), { name: "serpapi_maps" });
    api.registerTool((ctx) => createSerpApiMapsReviewsTool(api, ctx), {
      name: "serpapi_maps_reviews",
    });
    api.registerTool((ctx) => createSerpApiShoppingTool(api, ctx), { name: "serpapi_shopping" });
    api.registerTool((ctx) => createSerpApiAiOverviewTool(api, ctx), {
      name: "serpapi_ai_overview",
    });
    api.registerTool((ctx) => createSerpApiAmazonTool(api, ctx), { name: "serpapi_amazon" });
    api.registerTool((ctx) => createSerpApiAmazonProductTool(api, ctx), {
      name: "serpapi_amazon_product",
    });
    api.registerTool((ctx) => createSerpApiBingTool(api, ctx), { name: "serpapi_bing" });
    api.registerTool((ctx) => createSerpApiDuckDuckGoTool(api, ctx), {
      name: "serpapi_duckduckgo",
    });
    api.registerTool((ctx) => createSerpApiEbayTool(api, ctx), { name: "serpapi_ebay" });
    api.registerTool((ctx) => createSerpApiEbayProductTool(api, ctx), {
      name: "serpapi_ebay_product",
    });
    api.registerTool((ctx) => createSerpApiImmersiveProductTool(api, ctx), {
      name: "serpapi_immersive_product",
    });
    api.registerTool((ctx) => createSerpApiJobsTool(api, ctx), { name: "serpapi_jobs" });
    api.registerTool((ctx) => createSerpApiLensTool(api, ctx), { name: "serpapi_lens" });
    api.registerTool((ctx) => createSerpApiYouTubeTool(api, ctx), { name: "serpapi_youtube" });
    api.registerTool((ctx) => createSerpApiYouTubeTranscriptTool(api, ctx), {
      name: "serpapi_youtube_transcript",
    });
    api.registerTool((ctx) => createSerpApiYouTubeVideoTool(api, ctx), {
      name: "serpapi_youtube_video",
    });
    api.registerTool((ctx) => createSerpApiTrendsTool(api, ctx), { name: "serpapi_trends" });
    api.registerTool((ctx) => createSerpApiTripadvisorTool(api, ctx), {
      name: "serpapi_tripadvisor",
    });
    api.registerTool((ctx) => createSerpApiFlightsTool(api, ctx), { name: "serpapi_flights" });
    api.registerTool((ctx) => createSerpApiHotelsTool(api, ctx), { name: "serpapi_hotels" });
    api.registerTool((ctx) => createSerpApiEventsTool(api, ctx), { name: "serpapi_events" });
    api.registerTool((ctx) => createSerpApiFacebookProfileTool(api, ctx), {
      name: "serpapi_facebook_profile",
    });
    api.registerTool((ctx) => createSerpApiInstagramProfileTool(api, ctx), {
      name: "serpapi_instagram_profile",
    });
    api.registerTool((ctx) => createSerpApiFinanceTool(api, ctx), { name: "serpapi_finance" });
    api.registerTool((ctx) => createSerpApiYahooTool(api, ctx), { name: "serpapi_yahoo" });
    api.registerTool((ctx) => createSerpApiAutocompleteTool(api, ctx), {
      name: "serpapi_autocomplete",
    });
    api.registerTool((ctx) => createSerpApiWeatherTool(api, ctx), { name: "serpapi_weather" });
    api.registerTool((ctx) => createSerpApiWalmartTool(api, ctx), { name: "serpapi_walmart" });
    api.registerTool((ctx) => createSerpApiWalmartProductTool(api, ctx), {
      name: "serpapi_walmart_product",
    });
  },
});
