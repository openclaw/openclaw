import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { registerFeedSearchHttpRoute } from "./src/feed-search-http.js";
import { registerFeedSearchTool } from "./src/feed-search-tool.js";
import { closePool } from "./src/mysql-client.js";

export default definePluginEntry({
  id: "feed-search",
  name: "Feed Search",
  description:
    "Search feed monitor data from external MySQL with topic-based access control and LLM-powered queries.",
  register(api: OpenClawPluginApi) {
    registerFeedSearchTool(api);
    registerFeedSearchHttpRoute(api);

    // Register a background service for MySQL pool lifecycle
    api.registerService({
      id: "feed-search",
      start(ctx) {
        ctx.logger.info("[FEED_SEARCH] Service initialized");
      },
      async stop(ctx) {
        await closePool();
        ctx.logger.info("[FEED_SEARCH] MySQL pool closed, service stopped");
      },
    });
  },
});
