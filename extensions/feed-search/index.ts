import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { createFeedQueryToolFactory } from "./src/feed-query-tool.js";
import { closePool } from "./src/mysql-client.js";
import { installSqlQueryLogging } from "./src/mysql-query-logger.js";

export default definePluginEntry({
  id: "feed-search",
  name: "Feed Search",
  description:
    "Search feed monitor data from external MySQL with topic-based access control and LLM-powered queries.",
  register(api: OpenClawPluginApi) {
    // Structured, topic-scoped query tool for rabbitmq-<userId> chat agents.
    // Authorization resolves server-side from entity_auth; the factory hides
    // the tool from every other agent.
    api.registerTool(createFeedQueryToolFactory(api), { name: "feed_query" });

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
