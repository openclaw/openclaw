import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { closePool } from "./src/mysql-client.js";
import { installSqlQueryLogging } from "./src/mysql-query-logger.js";

export default definePluginEntry({
  id: "feed-search",
  name: "Feed Search",
  description:
    "Search feed monitor data from external MySQL with topic-based access control and LLM-powered queries.",
  register(api: OpenClawPluginApi) {
    // Register a background service for MySQL pool lifecycle
    api.registerService({
      id: "feed-search",
      start(ctx) {
        // Patch every resolvable mysql2 install (gateway in-process + the home-dir
        // install the agent's workspace scripts resolve) so all LLM-issued SQL is
        // appended to ~/.openclaw/logs/mysql-queries.jsonl. Defensive: never throws.
        installSqlQueryLogging(ctx.logger);
        ctx.logger.info("[FEED_SEARCH] Service initialized");
      },
      async stop(ctx) {
        await closePool();
        ctx.logger.info("[FEED_SEARCH] MySQL pool closed, service stopped");
      },
    });
  },
});
