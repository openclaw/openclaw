/**
 * OpenClaw Memory (Neo4j) Plugin
 *
 * Drop-in replacement for memory-lancedb with three-signal hybrid search,
 * entity extraction, and knowledge graph capabilities.
 *
 * Provides:
 * - memory_recall: Hybrid search (vector + BM25 + graph traversal)
 * - memory_store: Store memories with background entity extraction
 * - memory_forget: Delete memories with cascade cleanup
 *
 * Architecture decisions: see docs/memory-neo4j/ARCHITECTURE.md
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { stringEnum } from "openclaw/plugin-sdk";
import type { MemoryCategory, MemorySource } from "./schema.js";
import {
  MEMORY_CATEGORIES,
  memoryNeo4jConfigSchema,
  resolveExtractionConfig,
  vectorDimsForModel,
} from "./config.js";
import { Embeddings } from "./embeddings.js";
import { extractUserMessages, runSleepCycle } from "./extractor.js";
import { Neo4jMemoryClient } from "./neo4j-client.js";
import { hybridSearch } from "./search.js";

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryNeo4jPlugin = {
  id: "memory-neo4j",
  name: "Memory (Neo4j)",
  description:
    "Neo4j-backed long-term memory with three-signal hybrid search, entity extraction, and knowledge graph",
  kind: "memory" as const,
  configSchema: memoryNeo4jConfigSchema,

  register(api: OpenClawPluginApi) {
    // Parse configuration
    const cfg = memoryNeo4jConfigSchema.parse(api.pluginConfig);
    const extractionConfig = resolveExtractionConfig(cfg.extraction);
    const vectorDim = vectorDimsForModel(cfg.embedding.model);

    // Create shared resources
    const db = new Neo4jMemoryClient(
      cfg.neo4j.uri,
      cfg.neo4j.username,
      cfg.neo4j.password,
      vectorDim,
      api.logger,
    );
    const embeddings = new Embeddings(
      cfg.embedding.apiKey,
      cfg.embedding.model,
      cfg.embedding.provider,
      cfg.embedding.baseUrl,
    );

    api.logger.debug?.(
      `memory-neo4j: registered (uri: ${cfg.neo4j.uri}, provider: ${cfg.embedding.provider}, model: ${cfg.embedding.model}, ` +
        `extraction: ${extractionConfig.enabled ? extractionConfig.model : "disabled"})`,
    );

    // ========================================================================
    // Tools (using factory pattern for agentId)
    // ========================================================================

    // memory_recall — Three-signal hybrid search
    api.registerTool(
      (ctx) => {
        const agentId = ctx.agentId || "default";
        return {
          name: "memory_recall",
          label: "Memory Recall",
          description:
            "Search through long-term memories. Use when you need context about user preferences, past decisions, or previously discussed topics.",
          parameters: Type.Object({
            query: Type.String({ description: "Search query" }),
            limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
          }),
          async execute(_toolCallId: string, params: unknown) {
            const { query, limit = 5 } = params as {
              query: string;
              limit?: number;
            };

            const results = await hybridSearch(
              db,
              embeddings,
              query,
              limit,
              agentId,
              extractionConfig.enabled,
            );

            if (results.length === 0) {
              return {
                content: [{ type: "text", text: "No relevant memories found." }],
                details: { count: 0 },
              };
            }

            const text = results
              .map((r, i) => `${i + 1}. [${r.category}] ${r.text} (${(r.score * 100).toFixed(0)}%)`)
              .join("\n");

            const sanitizedResults = results.map((r) => ({
              id: r.id,
              text: r.text,
              category: r.category,
              importance: r.importance,
              score: r.score,
            }));

            return {
              content: [
                {
                  type: "text",
                  text: `Found ${results.length} memories:\n\n${text}`,
                },
              ],
              details: { count: results.length, memories: sanitizedResults },
            };
          },
        };
      },
      { name: "memory_recall" },
    );

    // memory_store — Store with background entity extraction
    api.registerTool(
      (ctx) => {
        const agentId = ctx.agentId || "default";
        const sessionKey = ctx.sessionKey;
        return {
          name: "memory_store",
          label: "Memory Store",
          description:
            "Save important information in long-term memory. Use for preferences, facts, decisions.",
          parameters: Type.Object({
            text: Type.String({ description: "Information to remember" }),
            importance: Type.Optional(
              Type.Number({
                description: "Importance 0-1 (default: 0.7)",
              }),
            ),
            category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
          }),
          async execute(_toolCallId: string, params: unknown) {
            const {
              text,
              importance = 0.7,
              category = "other",
            } = params as {
              text: string;
              importance?: number;
              category?: MemoryCategory;
            };

            // 1. Generate embedding
            const vector = await embeddings.embed(text);

            // 2. Check for duplicates (vector similarity > 0.95)
            const existing = await db.findSimilar(vector, 0.95, 1);
            if (existing.length > 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Similar memory already exists: "${existing[0].text}"`,
                  },
                ],
                details: {
                  action: "duplicate",
                  existingId: existing[0].id,
                  existingText: existing[0].text,
                },
              };
            }

            // 3. Store memory immediately (fast path)
            const memoryId = randomUUID();
            await db.storeMemory({
              id: memoryId,
              text,
              embedding: vector,
              importance: Math.min(1, Math.max(0, importance)),
              category,
              source: "user" as MemorySource,
              extractionStatus: extractionConfig.enabled ? "pending" : "skipped",
              agentId,
              sessionKey,
            });

            // 4. Extraction is deferred to sleep cycle (like human memory consolidation)
            // See: runSleepCycleExtraction() and `openclaw memory sleep` command

            return {
              content: [
                {
                  type: "text",
                  text: `Stored: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`,
                },
              ],
              details: { action: "created", id: memoryId },
            };
          },
        };
      },
      { name: "memory_store" },
    );

    // memory_forget — Delete with cascade
    api.registerTool(
      (_ctx) => {
        return {
          name: "memory_forget",
          label: "Memory Forget",
          description: "Delete specific memories. GDPR-compliant.",
          parameters: Type.Object({
            query: Type.Optional(Type.String({ description: "Search to find memory" })),
            memoryId: Type.Optional(Type.String({ description: "Specific memory ID" })),
          }),
          async execute(_toolCallId: string, params: unknown) {
            const { query, memoryId } = params as {
              query?: string;
              memoryId?: string;
            };

            // Direct delete by ID
            if (memoryId) {
              const deleted = await db.deleteMemory(memoryId);
              if (!deleted) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `Memory ${memoryId} not found.`,
                    },
                  ],
                  details: { action: "not_found", id: memoryId },
                };
              }
              return {
                content: [
                  {
                    type: "text",
                    text: `Memory ${memoryId} forgotten.`,
                  },
                ],
                details: { action: "deleted", id: memoryId },
              };
            }

            // Search-based delete
            if (query) {
              const vector = await embeddings.embed(query);
              const results = await db.vectorSearch(vector, 5, 0.7);

              if (results.length === 0) {
                return {
                  content: [{ type: "text", text: "No matching memories found." }],
                  details: { found: 0 },
                };
              }

              // Auto-delete if single high-confidence match
              if (results.length === 1 && results[0].score > 0.9) {
                await db.deleteMemory(results[0].id);
                return {
                  content: [
                    {
                      type: "text",
                      text: `Forgotten: "${results[0].text}"`,
                    },
                  ],
                  details: { action: "deleted", id: results[0].id },
                };
              }

              // Multiple candidates — ask user to specify
              const list = results.map((r) => `- [${r.id}] ${r.text.slice(0, 60)}...`).join("\n");

              const sanitizedCandidates = results.map((r) => ({
                id: r.id,
                text: r.text,
                category: r.category,
                score: r.score,
              }));

              return {
                content: [
                  {
                    type: "text",
                    text: `Found ${results.length} candidates. Specify memoryId:\n${list}`,
                  },
                ],
                details: {
                  action: "candidates",
                  candidates: sanitizedCandidates,
                },
              };
            }

            return {
              content: [{ type: "text", text: "Provide query or memoryId." }],
              details: { error: "missing_param" },
            };
          },
        };
      },
      { name: "memory_forget" },
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        // Find existing memory command or create fallback
        let memoryCmd = program.commands.find((cmd) => cmd.name() === "memory");
        if (!memoryCmd) {
          // Fallback if core memory CLI not registered yet
          memoryCmd = program.command("memory").description("Memory commands");
        }

        // Add neo4j memory subcommand group
        const memory = memoryCmd.command("neo4j").description("Neo4j graph memory commands");

        memory
          .command("list")
          .description("List memory counts by agent and category")
          .option("--json", "Output as JSON")
          .action(async (opts: { json?: boolean }) => {
            try {
              await db.ensureInitialized();
              const stats = await db.getMemoryStats();

              if (opts.json) {
                console.log(JSON.stringify(stats, null, 2));
                return;
              }

              if (stats.length === 0) {
                console.log("No memories stored.");
                return;
              }

              // Group by agentId
              const byAgent = new Map<
                string,
                Array<{ category: string; count: number; avgImportance: number }>
              >();
              for (const row of stats) {
                const list = byAgent.get(row.agentId) || [];
                list.push({
                  category: row.category,
                  count: row.count,
                  avgImportance: row.avgImportance,
                });
                byAgent.set(row.agentId, list);
              }

              // Print table for each agent
              for (const [agentId, categories] of byAgent) {
                const total = categories.reduce((sum, c) => sum + c.count, 0);
                console.log(`\n┌─ ${agentId} (${total} total)`);
                console.log("│");
                console.log("│  Category      Count   Avg Importance");
                console.log("│  ─────────────────────────────────────");
                for (const { category, count, avgImportance } of categories) {
                  const cat = category.padEnd(12);
                  const cnt = String(count).padStart(5);
                  const imp = (avgImportance * 100).toFixed(0).padStart(3) + "%";
                  console.log(`│  ${cat} ${cnt}   ${imp}`);
                }
                console.log("└");
              }
              console.log("");
            } catch (err) {
              console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
              process.exitCode = 1;
            }
          });

        memory
          .command("search")
          .description("Search memories")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "5")
          .action(async (query: string, opts: { limit: string }) => {
            try {
              const results = await hybridSearch(
                db,
                embeddings,
                query,
                parseInt(opts.limit, 10),
                "default",
                extractionConfig.enabled,
              );
              const output = results.map((r) => ({
                id: r.id,
                text: r.text,
                category: r.category,
                importance: r.importance,
                score: r.score,
              }));
              console.log(JSON.stringify(output, null, 2));
            } catch (err) {
              console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
              process.exitCode = 1;
            }
          });

        memory
          .command("stats")
          .description("Show memory statistics and configuration")
          .action(async () => {
            try {
              await db.ensureInitialized();
              const stats = await db.getMemoryStats();
              const total = stats.reduce((sum, s) => sum + s.count, 0);

              console.log("\nMemory (Neo4j) Statistics");
              console.log("─────────────────────────");
              console.log(`Total memories: ${total}`);
              console.log(`Neo4j URI:      ${cfg.neo4j.uri}`);
              console.log(`Embedding:      ${cfg.embedding.provider}/${cfg.embedding.model}`);
              console.log(
                `Extraction:     ${extractionConfig.enabled ? extractionConfig.model : "disabled"}`,
              );
              console.log(`Auto-capture:   ${cfg.autoCapture ? "enabled" : "disabled"}`);
              console.log(`Auto-recall:    ${cfg.autoRecall ? "enabled" : "disabled"}`);
              console.log(`Core memory:    ${cfg.coreMemory.enabled ? "enabled" : "disabled"}`);

              if (stats.length > 0) {
                // Group by category across all agents
                const byCategory = new Map<string, number>();
                for (const row of stats) {
                  byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + row.count);
                }
                console.log("\nBy Category:");
                for (const [category, count] of byCategory) {
                  console.log(`  ${category.padEnd(12)} ${count}`);
                }

                // Show agent count
                const agents = new Set(stats.map((s) => s.agentId));
                console.log(`\nAgents: ${agents.size} (${[...agents].join(", ")})`);
              }
              console.log("");
            } catch (err) {
              console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
              process.exitCode = 1;
            }
          });

        memory
          .command("sleep")
          .description(
            "Run sleep cycle — consolidate memories with Pareto-based promotion/demotion",
          )
          .option("--agent <id>", "Agent id (default: all agents)")
          .option("--dedup-threshold <n>", "Vector similarity threshold for dedup (default: 0.95)")
          .option("--pareto <n>", "Top N% for core memory (default: 0.2 = top 20%)")
          .option("--promotion-min-age <days>", "Min age in days before promotion (default: 7)")
          .option("--decay-threshold <n>", "Decay score threshold for pruning (default: 0.1)")
          .option("--decay-half-life <days>", "Base half-life in days (default: 30)")
          .option("--batch-size <n>", "Extraction batch size (default: 50)")
          .option("--delay <ms>", "Delay between extraction batches in ms (default: 1000)")
          .action(
            async (opts: {
              agent?: string;
              dedupThreshold?: string;
              pareto?: string;
              promotionMinAge?: string;
              decayThreshold?: string;
              decayHalfLife?: string;
              batchSize?: string;
              delay?: string;
            }) => {
              console.log("\n🌙 Memory Sleep Cycle");
              console.log("═════════════════════════════════════════════════════════════");
              console.log("Seven-phase memory consolidation (Pareto-based):\n");
              console.log("  Phase 1: Deduplication    — Merge near-duplicate memories");
              console.log(
                "  Phase 2: Pareto Scoring   — Calculate effective scores for all memories",
              );
              console.log("  Phase 3: Core Promotion   — Regular memories above threshold → core");
              console.log("  Phase 4: Core Demotion    — Core memories below threshold → regular");
              console.log("  Phase 5: Extraction       — Extract entities and categorize");
              console.log("  Phase 6: Decay & Pruning  — Remove stale low-importance memories");
              console.log("  Phase 7: Orphan Cleanup   — Remove disconnected nodes\n");

              try {
                await db.ensureInitialized();

                const result = await runSleepCycle(db, embeddings, extractionConfig, api.logger, {
                  agentId: opts.agent,
                  dedupThreshold: opts.dedupThreshold ? parseFloat(opts.dedupThreshold) : undefined,
                  paretoPercentile: opts.pareto ? parseFloat(opts.pareto) : undefined,
                  promotionMinAgeDays: opts.promotionMinAge
                    ? parseInt(opts.promotionMinAge, 10)
                    : undefined,
                  decayRetentionThreshold: opts.decayThreshold
                    ? parseFloat(opts.decayThreshold)
                    : undefined,
                  decayBaseHalfLifeDays: opts.decayHalfLife
                    ? parseInt(opts.decayHalfLife, 10)
                    : undefined,
                  extractionBatchSize: opts.batchSize ? parseInt(opts.batchSize, 10) : undefined,
                  extractionDelayMs: opts.delay ? parseInt(opts.delay, 10) : undefined,
                  onPhaseStart: (phase) => {
                    const phaseNames = {
                      dedup: "Phase 1: Deduplication",
                      pareto: "Phase 2: Pareto Scoring",
                      promotion: "Phase 3: Core Promotion",
                      demotion: "Phase 4: Core Demotion",
                      extraction: "Phase 5: Extraction",
                      decay: "Phase 6: Decay & Pruning",
                      cleanup: "Phase 7: Orphan Cleanup",
                    };
                    console.log(`\n▶ ${phaseNames[phase]}`);
                    console.log("─────────────────────────────────────────────────────────────");
                  },
                  onProgress: (_phase, message) => {
                    console.log(`   ${message}`);
                  },
                });

                console.log("\n═════════════════════════════════════════════════════════════");
                console.log(`✅ Sleep cycle complete in ${(result.durationMs / 1000).toFixed(1)}s`);
                console.log("─────────────────────────────────────────────────────────────");
                console.log(
                  `   Deduplication:  ${result.dedup.clustersFound} clusters → ${result.dedup.memoriesMerged} merged`,
                );
                console.log(
                  `   Pareto:         ${result.pareto.totalMemories} total (${result.pareto.coreMemories} core, ${result.pareto.regularMemories} regular)`,
                );
                console.log(
                  `                   Threshold: ${result.pareto.threshold.toFixed(4)} (top 20%)`,
                );
                console.log(
                  `   Promotion:      ${result.promotion.promoted}/${result.promotion.candidatesFound} promoted to core`,
                );
                console.log(
                  `   Demotion:       ${result.demotion.demoted}/${result.demotion.candidatesFound} demoted from core`,
                );
                console.log(`   Decay/Pruning:  ${result.decay.memoriesPruned} memories pruned`);
                console.log(
                  `   Extraction:     ${result.extraction.succeeded}/${result.extraction.total} extracted` +
                    (result.extraction.failed > 0 ? ` (${result.extraction.failed} failed)` : ""),
                );
                console.log(
                  `   Cleanup:        ${result.cleanup.entitiesRemoved} entities, ${result.cleanup.tagsRemoved} tags removed`,
                );
                if (result.aborted) {
                  console.log("\n⚠️  Sleep cycle was aborted before completion.");
                }
                console.log("");
              } catch (err) {
                console.error(
                  `\n❌ Sleep cycle failed: ${err instanceof Error ? err.message : String(err)}`,
                );
                process.exitCode = 1;
              }
            },
          );

        memory
          .command("promote")
          .description("Manually promote a memory to core status")
          .argument("<id>", "Memory ID to promote")
          .action(async (id: string) => {
            try {
              await db.ensureInitialized();
              const promoted = await db.promoteToCore([id]);
              if (promoted > 0) {
                console.log(`✅ Memory ${id} promoted to core.`);
              } else {
                console.log(`❌ Memory ${id} not found.`);
                process.exitCode = 1;
              }
            } catch (err) {
              console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
              process.exitCode = 1;
            }
          });
      },
      { commands: [] }, // Adds subcommands to existing "memory" command, no conflict
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // Track sessions where core memories have already been loaded (skip on subsequent turns).
    // NOTE: This is in-memory and will be cleared on gateway restart. The agent_bootstrap
    // hook below also checks for existing conversation history to avoid re-injecting core
    // memories after restarts.
    const bootstrappedSessions = new Set<string>();

    // Track mid-session refresh: maps sessionKey → tokens at last refresh
    // Used to avoid refreshing too frequently (only refresh after significant context growth)
    const midSessionRefreshAt = new Map<string, number>();
    const MIN_TOKENS_SINCE_REFRESH = 10_000; // Only refresh if context grew by 10k+ tokens

    // After compaction: clear bootstrap flag and mid-session refresh tracking
    if (cfg.coreMemory.enabled) {
      api.on("after_compaction", async (_event, ctx) => {
        if (ctx.sessionKey) {
          bootstrappedSessions.delete(ctx.sessionKey);
          midSessionRefreshAt.delete(ctx.sessionKey);
          api.logger.info?.(
            `memory-neo4j: cleared bootstrap/refresh flags for session ${ctx.sessionKey} after compaction`,
          );
        }
      });
    }

    // Mid-session core memory refresh: re-inject core memories when context grows past threshold
    // This counters the "lost in the middle" phenomenon by placing core memories closer to end of context
    const refreshThreshold = cfg.coreMemory.refreshAtContextPercent;
    if (cfg.coreMemory.enabled && refreshThreshold) {
      api.logger.debug?.(
        `memory-neo4j: registering before_agent_start hook for mid-session core refresh at ${refreshThreshold}%`,
      );
      api.on("before_agent_start", async (event, ctx) => {
        // Skip if context info not available
        if (!event.contextWindowTokens || !event.estimatedUsedTokens) {
          return;
        }

        const sessionKey = ctx.sessionKey ?? "";
        const agentId = ctx.agentId || "default";
        const usagePercent = (event.estimatedUsedTokens / event.contextWindowTokens) * 100;

        // Only refresh if we've crossed the threshold
        if (usagePercent < refreshThreshold) {
          return;
        }

        // Check if we've already refreshed recently (prevent over-refreshing)
        const lastRefreshTokens = midSessionRefreshAt.get(sessionKey) ?? 0;
        const tokensSinceRefresh = event.estimatedUsedTokens - lastRefreshTokens;
        if (tokensSinceRefresh < MIN_TOKENS_SINCE_REFRESH) {
          api.logger.debug?.(
            `memory-neo4j: skipping mid-session refresh (only ${tokensSinceRefresh} tokens since last refresh)`,
          );
          return;
        }

        try {
          const maxEntries = cfg.coreMemory.maxEntries;
          const coreMemories = await db.listByCategory("core", maxEntries, 0, agentId);

          if (coreMemories.length === 0) {
            return;
          }

          // Record this refresh
          midSessionRefreshAt.set(sessionKey, event.estimatedUsedTokens);

          const content = coreMemories.map((m) => `- ${m.text}`).join("\n");
          api.logger.info?.(
            `memory-neo4j: mid-session core refresh at ${usagePercent.toFixed(1)}% context (${coreMemories.length} memories)`,
          );

          return {
            prependContext: `<core-memory-refresh>\nReminder of persistent context (you may have seen this earlier, re-stating for recency):\n${content}\n</core-memory-refresh>`,
          };
        } catch (err) {
          api.logger.warn(`memory-neo4j: mid-session core refresh failed: ${String(err)}`);
        }
      });
    }

    // Auto-recall: inject relevant memories before agent starts
    api.logger.debug?.(`memory-neo4j: autoRecall=${cfg.autoRecall}`);
    if (cfg.autoRecall) {
      api.logger.debug?.("memory-neo4j: registering before_agent_start hook for auto-recall");
      api.on("before_agent_start", async (event, ctx) => {
        if (!event.prompt || event.prompt.length < 5) {
          return;
        }

        const agentId = ctx.agentId || "default";

        // Truncate prompt to avoid exceeding embedding model context length
        // ~6000 chars is safe for most embedding models (leaves headroom for 2k tokens)
        const MAX_QUERY_CHARS = 6000;
        const query =
          event.prompt.length > MAX_QUERY_CHARS
            ? event.prompt.slice(0, MAX_QUERY_CHARS)
            : event.prompt;

        try {
          const results = await hybridSearch(
            db,
            embeddings,
            query,
            3,
            agentId,
            extractionConfig.enabled,
          );

          if (results.length === 0) {
            return;
          }

          const memoryContext = results.map((r) => `- [${r.category}] ${r.text}`).join("\n");

          api.logger.info?.(`memory-neo4j: injecting ${results.length} memories into context`);
          api.logger.debug?.(
            `memory-neo4j: auto-recall memories: ${JSON.stringify(results.map((r) => ({ id: r.id, text: r.text.slice(0, 80), category: r.category, score: r.score })))}`,
          );

          return {
            prependContext: `<relevant-memories>\nThe following memories may be relevant to this conversation:\n${memoryContext}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn(`memory-neo4j: auto-recall failed: ${String(err)}`);
        }
      });
    }

    // Core memories: inject as virtual MEMORY.md at bootstrap time (scoped by agentId).
    // Only runs on new sessions and after compaction (not every turn).
    api.logger.debug?.(`memory-neo4j: coreMemory.enabled=${cfg.coreMemory.enabled}`);
    if (cfg.coreMemory.enabled) {
      api.logger.debug?.("memory-neo4j: registering agent_bootstrap hook for core memories");
      api.on("agent_bootstrap", async (event, ctx) => {
        const sessionKey = ctx.sessionKey;

        // Skip if this session was already bootstrapped (avoid re-loading every turn).
        // The after_compaction hook clears the flag so we re-inject after compaction.
        if (sessionKey && bootstrappedSessions.has(sessionKey)) {
          api.logger.debug?.(
            `memory-neo4j: skipping core memory injection for already-bootstrapped session=${sessionKey}`,
          );
          return;
        }

        // Log when we're about to inject core memories for a session that wasn't tracked
        // This helps diagnose cases where context might be lost after gateway restarts
        if (sessionKey) {
          api.logger.debug?.(
            `memory-neo4j: session=${sessionKey} not in bootstrappedSessions (size=${bootstrappedSessions.size}), will check for core memories`,
          );
        }

        try {
          const agentId = ctx.agentId || "default";
          const maxEntries = cfg.coreMemory.maxEntries;

          api.logger.debug?.(
            `memory-neo4j: loading core memories for agent=${agentId} session=${sessionKey ?? "unknown"}`,
          );
          // Core memories are always included (no importance filter) - if marked as core, it's important
          // Results are ordered by importance desc, so most important come first up to maxEntries
          const coreMemories = await db.listByCategory("core", maxEntries, 0, agentId);

          if (coreMemories.length === 0) {
            if (sessionKey) {
              bootstrappedSessions.add(sessionKey);
            }
            api.logger.debug?.(
              `memory-neo4j: no core memories found for agent=${agentId}, marking session as bootstrapped`,
            );
            return;
          }

          // Format core memories into a MEMORY.md-style document
          let content = "# Core Memory\n\n";
          content += "*Persistent context loaded from long-term memory*\n\n";
          for (const mem of coreMemories) {
            content += `- ${mem.text}\n`;
          }

          // Find and replace MEMORY.md in the files list, or add it
          const files = [...event.files];
          const memoryIndex = files.findIndex(
            (f) => f.name === "MEMORY.md" || f.name === "memory.md",
          );

          const virtualFile = {
            name: "MEMORY.md" as const,
            path: "memory://neo4j/core-memory",
            content,
            missing: false,
          };

          const action = memoryIndex >= 0 ? "replaced" : "added";
          if (memoryIndex >= 0) {
            files[memoryIndex] = virtualFile;
          } else {
            files.push(virtualFile);
          }

          if (sessionKey) {
            bootstrappedSessions.add(sessionKey);
          }
          // Log at info level when actually injecting, debug for skips
          api.logger.info?.(
            `memory-neo4j: ${action} MEMORY.md with ${coreMemories.length} core memories for agent=${agentId} session=${sessionKey ?? "unknown"}`,
          );

          return { files };
        } catch (err) {
          api.logger.warn(`memory-neo4j: core memory injection failed: ${String(err)}`);
        }
      });
    }

    // Auto-capture: attention-gated memory pipeline modeled on human memory.
    //
    // Phase 1 — Attention gating (real-time):
    //   Lightweight heuristic filter rejects obvious noise (greetings, short
    //   acks, system markup, code dumps) without any LLM call.
    //
    // Phase 2 — Short-term retention:
    //   Everything that passes the gate is embedded, deduped, and stored as
    //   regular memory with extractionStatus "pending".
    //
    // Phase 3 — Sleep consolidation (deferred to `openclaw memory neo4j sleep`):
    //   The sleep cycle handles entity extraction, categorization, Pareto
    //   scoring, promotion/demotion, and decay — mirroring hippocampal replay.
    api.logger.debug?.(
      `memory-neo4j: autoCapture=${cfg.autoCapture}, extraction.enabled=${extractionConfig.enabled}`,
    );
    if (cfg.autoCapture) {
      api.logger.debug?.("memory-neo4j: registering agent_end hook for auto-capture");
      api.on("agent_end", async (event, ctx) => {
        api.logger.debug?.(
          `memory-neo4j: agent_end fired (success=${event.success}, messages=${event.messages?.length ?? 0})`,
        );
        if (!event.success || !event.messages || event.messages.length === 0) {
          api.logger.debug?.("memory-neo4j: skipping - no success or empty messages");
          return;
        }

        const agentId = ctx.agentId || "default";
        const sessionKey = ctx.sessionKey;

        try {
          const userMessages = extractUserMessages(event.messages);
          if (userMessages.length === 0) {
            return;
          }

          // Phase 1: Attention gating — fast heuristic filter
          const retained = userMessages.filter((text) => passesAttentionGate(text));
          if (retained.length === 0) {
            return;
          }

          // Phase 2: Short-term retention — embed, dedup, store
          let stored = 0;
          for (const text of retained) {
            try {
              const vector = await embeddings.embed(text);

              // Quick dedup (same content already stored)
              const existing = await db.findSimilar(vector, 0.95, 1);
              if (existing.length > 0) {
                continue;
              }

              await db.storeMemory({
                id: randomUUID(),
                text,
                embedding: vector,
                importance: 0.5, // neutral — sleep cycle scores via Pareto
                category: "other", // sleep cycle will categorize
                source: "auto-capture",
                extractionStatus: extractionConfig.enabled ? "pending" : "skipped",
                agentId,
                sessionKey,
              });
              stored++;
            } catch (err) {
              api.logger.debug?.(`memory-neo4j: auto-capture item failed: ${String(err)}`);
            }
          }

          if (stored > 0) {
            api.logger.info(`memory-neo4j: auto-captured ${stored} memories (attention-gated)`);
          }
        } catch (err) {
          api.logger.warn(`memory-neo4j: auto-capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "memory-neo4j",
      start: async () => {
        try {
          await db.ensureInitialized();
          api.logger.info(
            `memory-neo4j: service started (uri: ${cfg.neo4j.uri}, model: ${cfg.embedding.model})`,
          );
        } catch (err) {
          api.logger.error(
            `memory-neo4j: failed to start — ${String(err)}. Memory tools will attempt lazy initialization.`,
          );
          // Don't throw — allow graceful degradation.
          // Tools will retry initialization on first use.
        }
      },
      stop: async () => {
        await db.close();
        api.logger.info("memory-neo4j: service stopped");
      },
    });
  },
};

// ============================================================================
// Attention gate — lightweight heuristic filter (phase 1 of memory pipeline)
//
// Rejects obvious noise without any LLM call, analogous to how the brain's
// sensory gating filters out irrelevant stimuli before they enter working
// memory. Everything that passes gets stored; the sleep cycle decides what
// matters.
// ============================================================================

const NOISE_PATTERNS = [
  // Greetings / acknowledgments
  /^(hi|hey|hello|yo|sup|ok|okay|sure|thanks|thank you|thx|ty|yep|yup|nope|no|yes|yeah|cool|nice|great|got it|sounds good|perfect|alright|fine|noted|ack|kk|k)\s*[.!?]*$/i,
  // Single-word or near-empty
  /^\S{0,3}$/,
  // Pure emoji
  /^[\p{Emoji}\s]+$/u,
  // System/XML markup
  /^<[a-z-]+>[\s\S]*<\/[a-z-]+>$/i,
];

/** Maximum message length — code dumps, logs, etc. are not memories. */
const MAX_CAPTURE_CHARS = 2000;

/** Minimum message length — too short to be meaningful. */
const MIN_CAPTURE_CHARS = 10;

function passesAttentionGate(text: string): boolean {
  const trimmed = text.trim();

  // Length bounds
  if (trimmed.length < MIN_CAPTURE_CHARS || trimmed.length > MAX_CAPTURE_CHARS) {
    return false;
  }

  // Injected context from the memory system itself
  if (trimmed.includes("<relevant-memories>") || trimmed.includes("<core-memory-refresh>")) {
    return false;
  }

  // Noise patterns
  if (NOISE_PATTERNS.some((r) => r.test(trimmed))) {
    return false;
  }

  // Excessive emoji (likely reaction, not substance)
  const emojiCount = (trimmed.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) {
    return false;
  }

  // Passes gate — retain for short-term storage
  return true;
}

// ============================================================================
// Export
// ============================================================================

export default memoryNeo4jPlugin;
