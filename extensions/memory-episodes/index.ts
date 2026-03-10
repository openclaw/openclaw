/**
 * OpenClaw Episode Memory Plugin
 *
 * Mid-term episodic memory with Postgres/pgvector storage.
 * Provides session summarization, context injection, and unified memory commands.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-episodes";
import { registerCommands } from "./src/commands.js";
import { parseConfig } from "./src/config.js";
import { EpisodeDb } from "./src/db.js";
import { registerHooks } from "./src/hooks.js";
import { Mem0Client } from "./src/mem0-client.js";

const episodesPlugin = {
  id: "memory-episodes",
  name: "Episode Memory",
  description: "Mid-term episodic memory with session summaries and custom memory commands",

  register(api: OpenClawPluginApi) {
    const config = parseConfig(api.pluginConfig);
    const db = new EpisodeDb(config.postgres.connectionString);
    const mem0 = new Mem0Client(config.mem0.baseUrl);

    const embeddingConfig = {
      baseUrl: config.embedding.baseUrl,
      model: config.embedding.model,
      dimensions: config.embedding.dimensions,
    };

    const extractionConfig = {
      model: config.extraction.model,
      baseUrl: config.extraction.baseUrl,
      apiKey: config.extraction.apiKey,
      maxSummaryTokens: config.extraction.maxSummaryTokens,
    };

    api.logger.info(
      `memory-episodes: registered (pg: ${config.postgres.connectionString.replace(/\/\/[^@]+@/, "//***@")})`,
    );

    // Register hooks (session finalization + context injection)
    registerHooks(api, { db, embeddingConfig, extractionConfig, config });

    // Register slash commands (/recall, /forget, /memory, /clear)
    registerCommands(api, { db, embeddingConfig, extractionConfig, mem0, config });

    // Register CLI subcommands
    api.registerCli(
      ({ program }) => {
        const episodes = program
          .command("episodes")
          .description("Episode memory plugin commands");

        episodes
          .command("stats")
          .description("Show episode statistics")
          .argument("[user-id]", "User ID", "default")
          .action(async (userId: string) => {
            await db.ensureSchema();
            const stats = await db.getEpisodeStats(userId);
            console.log(`Total episodes: ${stats.totalEpisodes}`);
            if (stats.latestEpisodeAt) {
              console.log(`Latest: ${stats.latestEpisodeAt.toISOString()}`);
            }
            if (stats.oldestEpisodeAt) {
              console.log(`Oldest: ${stats.oldestEpisodeAt.toISOString()}`);
            }
          });

        episodes
          .command("list")
          .description("List recent episodes")
          .argument("[user-id]", "User ID", "default")
          .option("--limit <n>", "Max results", "10")
          .action(async (userId: string, opts: { limit: string }) => {
            await db.ensureSchema();
            const results = await db.getRecentEpisodes(userId, undefined, parseInt(opts.limit));
            for (const ep of results) {
              console.log(
                `${ep.episodeId.slice(0, 8)} | ${ep.endedAt.toISOString()} | ${ep.summary.slice(0, 80)}`,
              );
            }
          });

        episodes
          .command("show")
          .description("Show episode details")
          .argument("<episode-id>", "Episode UUID")
          .action(async (episodeId: string) => {
            await db.ensureSchema();
            const ep = await db.getEpisodeById(episodeId);
            if (!ep) {
              console.log("Episode not found.");
              return;
            }
            console.log(JSON.stringify(ep, null, 2));
          });

        episodes
          .command("cleanup")
          .description("Remove old episodes")
          .option("--max-age <days>", "Max age in days", "90")
          .action(async (opts: { maxAge: string }) => {
            await db.ensureSchema();
            const removed = await db.cleanupOldEpisodes(parseInt(opts.maxAge));
            console.log(`Removed ${removed} old episodes.`);
          });

        episodes
          .command("init-db")
          .description("Initialize the episodes database schema")
          .action(async () => {
            await db.ensureSchema();
            console.log("Episodes database schema initialized.");
          });
      },
      { commands: ["episodes"] },
    );

    // Register service for lifecycle management and periodic cleanup
    api.registerService({
      id: "memory-episodes",
      async start() {
        try {
          await db.ensureSchema();
          api.logger.info("memory-episodes: database schema verified");
        } catch (err) {
          api.logger.warn(
            `memory-episodes: schema init failed (will retry on first use): ${String(err)}`,
          );
        }

        // Periodic cleanup (if retention is enabled)
        if (config.retention.enabled) {
          const intervalMs = 6 * 60 * 60 * 1000; // 6 hours
          const timer = setInterval(async () => {
            try {
              const removed = await db.cleanupOldEpisodes(config.retention.maxAgeDays);
              if (removed > 0) {
                api.logger.info(`memory-episodes: cleaned up ${removed} old episodes`);
              }
            } catch (err) {
              api.logger.warn(`memory-episodes: cleanup failed: ${String(err)}`);
            }
          }, intervalMs);
          // Ensure the timer doesn't keep the process alive
          timer.unref?.();
        }
      },
      async stop() {
        await db.close();
        api.logger.info("memory-episodes: stopped");
      },
    });
  },
};

export default episodesPlugin;
