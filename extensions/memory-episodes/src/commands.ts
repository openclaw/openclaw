/**
 * Episode Memory Slash Commands
 *
 * Registers /recall, /forget, /memory, and /clear commands.
 * These bypass the LLM agent and return direct replies.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi, PluginCommandContext } from "openclaw/plugin-sdk/memory-episodes";
import type { EpisodesConfig } from "./config.js";
import type { EpisodeDb, EpisodeSearchResult } from "./db.js";
import type { EmbeddingConfig } from "./embedding.js";
import { embed } from "./embedding.js";
import { generateEpisode, MIN_MESSAGES_FOR_EPISODE } from "./episode-generator.js";
import type { ExtractionConfig } from "./episode-generator.js";
import { formatEpisodeDetail, formatMemoryDashboard, formatRecallResults } from "./format.js";
import type { Mem0Client } from "./mem0-client.js";

type CommandDeps = {
  db: EpisodeDb;
  embeddingConfig: EmbeddingConfig;
  extractionConfig: ExtractionConfig;
  mem0: Mem0Client;
  config: EpisodesConfig;
};

/** Parse simple flags from args string: "--long-term" => { longTerm: true, remaining: "..." } */
function parseFlags(args: string): {
  longTerm: boolean;
  sessions: boolean;
  all: boolean;
  discard: boolean;
  fast: boolean;
  remaining: string;
} {
  const flags = {
    longTerm: false,
    sessions: false,
    all: false,
    discard: false,
    fast: false,
  };

  const words = args.split(/\s+/);
  const remaining: string[] = [];

  for (const word of words) {
    if (word === "--long-term") {
      flags.longTerm = true;
    } else if (word === "--sessions") {
      flags.sessions = true;
    } else if (word === "--all") {
      flags.all = true;
    } else if (word === "--discard") {
      flags.discard = true;
    } else if (word === "--fast") {
      flags.fast = true;
    } else {
      remaining.push(word);
    }
  }

  return { ...flags, remaining: remaining.join(" ").trim() };
}

/** Derive a userId from the command context. */
function resolveUserId(ctx: PluginCommandContext): string {
  return ctx.senderId ?? ctx.from ?? "default";
}

export function registerCommands(api: OpenClawPluginApi, deps: CommandDeps): void {
  const { db, embeddingConfig, mem0, config } = deps;

  // =========================================================================
  // /recall [query] — search both episode and long-term memory
  // =========================================================================
  api.registerCommand({
    name: "recall",
    description: "Search long-term and session memory",
    acceptsArgs: true,
    handler: async (ctx) => {
      const { longTerm, sessions, remaining } = parseFlags(ctx.args ?? "");
      const query = remaining;
      const userId = resolveUserId(ctx);

      if (!query) {
        // No query: show recent episodes
        try {
          const recent = await db.getRecentEpisodes(userId, undefined, 5);
          if (recent.length === 0) {
            return { text: "No episodes recorded yet." };
          }
          const lines = recent.map(
            (ep) => `- ${ep.endedAt.toLocaleDateString()}: ${ep.summary.slice(0, 120)}`,
          );
          return { text: `**Recent Sessions**\n${lines.join("\n")}` };
        } catch (err) {
          api.logger.warn(`memory-episodes: /recall error: ${String(err)}`);
          return { text: "Failed to retrieve episodes." };
        }
      }

      // Search both stores (unless filtered by flags)
      const searchSessions = !longTerm || sessions;
      const searchLongTerm = !sessions || longTerm;

      let episodes: EpisodeSearchResult[] = [];
      let memories: Array<{ id: string; memory: string }> = [];

      if (searchSessions) {
        try {
          const embedding = await embed(query, embeddingConfig);
          episodes = await db.searchEpisodes({
            embedding,
            userId,
            maxResults: config.retrieval.maxResults,
            maxAgeDays: config.retrieval.maxAgeDays,
            threshold: config.retrieval.similarityThreshold,
          });
        } catch (err) {
          api.logger.warn(`memory-episodes: episode search failed: ${String(err)}`);
        }
      }

      if (searchLongTerm && config.mem0.enabled) {
        try {
          memories = await mem0.search(query, userId, 5);
        } catch (err) {
          api.logger.warn(`memory-episodes: mem0 search failed: ${String(err)}`);
        }
      }

      return { text: formatRecallResults(episodes, memories) };
    },
  });

  // =========================================================================
  // /forget [query|id] — remove memories
  // =========================================================================
  api.registerCommand({
    name: "forget",
    description: "Remove memories",
    acceptsArgs: true,
    handler: async (ctx) => {
      const { all, longTerm, sessions, remaining } = parseFlags(ctx.args ?? "");
      const userId = resolveUserId(ctx);

      // Delete all memories
      if (all) {
        let deletedEpisodes = 0;
        let deletedMemories = 0;

        if (!longTerm || sessions) {
          try {
            deletedEpisodes = await db.deleteAllUserEpisodes(userId);
          } catch (err) {
            api.logger.warn(`memory-episodes: delete all episodes failed: ${String(err)}`);
          }
        }

        if ((!sessions || longTerm) && config.mem0.enabled) {
          try {
            const mems = await mem0.list(userId);
            for (const m of mems) {
              if (await mem0.delete(m.id)) {
                deletedMemories++;
              }
            }
          } catch (err) {
            api.logger.warn(`memory-episodes: delete all mem0 failed: ${String(err)}`);
          }
        }

        return {
          text: `Deleted ${deletedEpisodes} episodes and ${deletedMemories} long-term memories.`,
        };
      }

      if (!remaining) {
        return { text: "Usage: /forget <query|episode-id> or /forget --all" };
      }

      // Check if it looks like a UUID (episode ID)
      const uuidPattern = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
      if (uuidPattern.test(remaining)) {
        try {
          const deleted = await db.deleteEpisode(remaining);
          return {
            text: deleted
              ? `Episode ${remaining.slice(0, 8)} deleted.`
              : `Episode ${remaining.slice(0, 8)} not found.`,
          };
        } catch (err) {
          api.logger.warn(`memory-episodes: delete episode failed: ${String(err)}`);
          return { text: "Failed to delete episode." };
        }
      }

      // Search and show candidates
      try {
        const embedding = await embed(remaining, embeddingConfig);
        const results = await db.searchEpisodes({
          embedding,
          userId,
          maxResults: 5,
          maxAgeDays: 365,
          threshold: 0.2,
        });

        if (results.length === 0) {
          return { text: "No matching episodes found." };
        }

        // If single high-confidence match, delete it
        if (results.length === 1 && results[0].similarity > 0.8) {
          await db.deleteEpisode(results[0].episode.episodeId);
          return {
            text: `Deleted episode: ${results[0].episode.summary.slice(0, 100)}`,
          };
        }

        // Show candidates for manual selection
        const lines = results.map(
          (r) =>
            `- \`${r.episode.episodeId}\` (${Math.round(r.similarity * 100)}%): ${r.episode.summary.slice(0, 80)}`,
        );
        return {
          text: `Found ${results.length} matching episodes. Use /forget <id> to delete:\n${lines.join("\n")}`,
        };
      } catch (err) {
        api.logger.warn(`memory-episodes: /forget search failed: ${String(err)}`);
        return { text: "Failed to search episodes." };
      }
    },
  });

  // =========================================================================
  // /memory — memory dashboard
  // =========================================================================
  api.registerCommand({
    name: "memory",
    description: "Memory dashboard",
    handler: async (ctx) => {
      const userId = resolveUserId(ctx);

      let episodeCount = 0;
      let latestEpisode: Date | null = null;
      let dbHealthy = false;

      try {
        const stats = await db.getEpisodeStats(userId);
        episodeCount = stats.totalEpisodes;
        latestEpisode = stats.latestEpisodeAt;
        dbHealthy = true;
      } catch (err) {
        api.logger.warn(`memory-episodes: /memory stats failed: ${String(err)}`);
      }

      let mem0Count: number | null = null;
      let mem0Healthy = false;

      if (config.mem0.enabled) {
        try {
          const health = await mem0.health();
          mem0Healthy = health !== null;
          if (mem0Healthy) {
            const mems = await mem0.list(userId);
            mem0Count = mems.length;
          }
        } catch {
          // mem0 is down, that's fine
        }
      }

      return {
        text: formatMemoryDashboard({
          episodeCount,
          latestEpisode,
          mem0Count,
          mem0Healthy,
          dbHealthy,
        }),
      };
    },
  });

  // =========================================================================
  // /clear — finalize session and clear context
  // =========================================================================
  api.registerCommand({
    name: "clear",
    description: "Finalize session and clear context",
    acceptsArgs: true,
    handler: async (ctx) => {
      const { discard } = parseFlags(ctx.args ?? "");

      if (discard) {
        return {
          text: "Session discarded (no episode created). Use /new to start fresh.",
        };
      }

      // The actual episode creation happens in the before_reset hook when /new fires.
      // This command just informs the user about what will happen.
      return {
        text: "Session will be saved as an episode when you reset (/new). Use /clear --discard to skip.",
      };
    },
  });

  // =========================================================================
  // /reset-all — delete all active session .jsonl files
  //   Nukes session files directly. No hooks, no LLM calls, no waiting.
  //   Crons (stored in ~/.openclaw/cron/) are never touched.
  // =========================================================================
  api.registerCommand({
    name: "reset-all",
    description: "Delete all active session files (no hooks, instant)",
    acceptsArgs: false,
    handler: async () => {
      try {
        const agentsDir = path.join(os.homedir(), ".openclaw", "agents");

        if (!fs.existsSync(agentsDir)) {
          return { text: "No agents directory found." };
        }

        const agentDirs = fs
          .readdirSync(agentsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory());

        let deleted = 0;
        const errors: string[] = [];

        for (const agent of agentDirs) {
          const sessionsDir = path.join(agentsDir, agent.name, "sessions");
          if (!fs.existsSync(sessionsDir)) continue;

          const files = fs
            .readdirSync(sessionsDir)
            .filter((f) => f.endsWith(".jsonl") && !f.includes(".reset."));

          for (const file of files) {
            try {
              fs.unlinkSync(path.join(sessionsDir, file));
              deleted++;
            } catch (err) {
              errors.push(`${agent.name}/${file}: ${String(err)}`);
            }
          }
        }

        const msg = `Deleted ${deleted} session file(s) across ${agentDirs.length} agents.`;
        return {
          text: errors.length > 0 ? `${msg}\n${errors.length} failed:\n${errors.join("\n")}` : msg,
        };
      } catch (err) {
        api.logger.warn(`memory-episodes: /reset-all error: ${String(err)}`);
        return { text: `Failed: ${String(err)}` };
      }
    },
  });
}
