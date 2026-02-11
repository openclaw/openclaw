/**
 * CLI command registration for memory-neo4j.
 *
 * Registers the `openclaw memory neo4j` subcommand group with commands:
 * - list: List memory counts by agent and category
 * - search: Search memories via hybrid search
 * - stats: Show memory statistics and configuration
 * - sleep: Run sleep cycle (seven-phase memory consolidation)
 * - promote: Manually promote a memory to core
 * - index: Re-embed all memories after changing embedding model
 * - cleanup: Retroactively apply attention gate to stored memories
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ExtractionConfig, MemoryNeo4jConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import { passesAttentionGate } from "./attention-gate.js";
import { stripMessageWrappers } from "./message-utils.js";
import { hybridSearch } from "./search.js";
import { runSleepCycle } from "./sleep-cycle.js";

export type CliDeps = {
  db: Neo4jMemoryClient;
  embeddings: Embeddings;
  cfg: MemoryNeo4jConfig;
  extractionConfig: ExtractionConfig;
  vectorDim: number;
};

/**
 * Register the `openclaw memory neo4j` CLI subcommand group.
 */
export function registerCli(api: OpenClawPluginApi, deps: CliDeps): void {
  const { db, embeddings, cfg, extractionConfig, vectorDim } = deps;

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
        .description("List memories grouped by agent and category")
        .option("--agent <id>", "Filter by agent id")
        .option("--category <name>", "Filter by category")
        .option("--limit <n>", "Max memories per category (default: 20)")
        .option("--json", "Output as JSON")
        .action(
          async (opts: { agent?: string; category?: string; limit?: string; json?: boolean }) => {
            try {
              await db.ensureInitialized();
              const perCategoryLimit = opts.limit ? parseInt(opts.limit, 10) : 20;
              if (Number.isNaN(perCategoryLimit) || perCategoryLimit <= 0) {
                console.error("Error: --limit must be greater than 0");
                process.exitCode = 1;
                return;
              }

              // Build query with optional filters
              const conditions: string[] = [];
              const params: Record<string, unknown> = {};
              if (opts.agent) {
                conditions.push("m.agentId = $agentId");
                params.agentId = opts.agent;
              }
              if (opts.category) {
                conditions.push("m.category = $category");
                params.category = opts.category;
              }
              const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

              const rows = await db.runQuery<{
                agentId: string;
                category: string;
                id: string;
                text: string;
                importance: number;
                createdAt: string;
                source: string;
              }>(
                `MATCH (m:Memory) ${where}
                 WITH m.agentId AS agentId, m.category AS category, m
                 ORDER BY m.importance DESC
                 WITH agentId, category, collect({
                   id: m.id, text: m.text, importance: m.importance,
                   createdAt: m.createdAt, source: coalesce(m.source, 'unknown')
                 }) AS memories
                 UNWIND memories[0..${perCategoryLimit}] AS mem
                 RETURN agentId, category,
                        mem.id AS id, mem.text AS text,
                        mem.importance AS importance,
                        mem.createdAt AS createdAt,
                        mem.source AS source
                 ORDER BY agentId, category, importance DESC`,
                params,
              );

              if (opts.json) {
                console.log(JSON.stringify(rows, null, 2));
                return;
              }

              if (rows.length === 0) {
                console.log("No memories found.");
                return;
              }

              // Group by agent → category → memories
              const byAgent = new Map<
                string,
                Map<
                  string,
                  Array<{
                    id: string;
                    text: string;
                    importance: number;
                    createdAt: string;
                    source: string;
                  }>
                >
              >();
              for (const row of rows) {
                const agent = (row.agentId as string) ?? "default";
                const cat = (row.category as string) ?? "other";
                if (!byAgent.has(agent)) byAgent.set(agent, new Map());
                const catMap = byAgent.get(agent)!;
                if (!catMap.has(cat)) catMap.set(cat, []);
                catMap.get(cat)!.push({
                  id: row.id as string,
                  text: row.text as string,
                  importance: row.importance as number,
                  createdAt: row.createdAt as string,
                  source: row.source as string,
                });
              }

              const impBar = (ratio: number) => {
                const W = 10;
                const filled = Math.round(ratio * W);
                return "█".repeat(filled) + "░".repeat(W - filled);
              };

              for (const [agentId, categories] of byAgent) {
                const agentTotal = [...categories.values()].reduce((s, m) => s + m.length, 0);
                console.log(`\n┌─ ${agentId} (${agentTotal} shown)`);

                for (const [category, memories] of categories) {
                  console.log(`│\n│  ── ${category} (${memories.length}) ──`);
                  for (const mem of memories) {
                    const pct = ((mem.importance * 100).toFixed(0) + "%").padStart(4);
                    const preview = mem.text.length > 72 ? `${mem.text.slice(0, 69)}...` : mem.text;
                    console.log(`│  ${impBar(mem.importance)} ${pct}  ${preview}`);
                  }
                }
                console.log("└");
              }
              console.log("");
            } catch (err) {
              console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
              process.exitCode = 1;
            }
          },
        );

      memory
        .command("search")
        .description("Search memories")
        .argument("<query>", "Search query")
        .option("--limit <n>", "Max results", "5")
        .option("--agent <id>", "Agent id (default: default)")
        .action(async (query: string, opts: { limit: string; agent?: string }) => {
          try {
            const results = await hybridSearch(
              db,
              embeddings,
              query,
              parseInt(opts.limit, 10),
              opts.agent ?? "default",
              extractionConfig.enabled,
              { graphSearchDepth: cfg.graphSearchDepth },
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
              const BAR_WIDTH = 20;
              const bar = (ratio: number) => {
                const filled = Math.round(ratio * BAR_WIDTH);
                return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
              };

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

              for (const [agentId, categories] of byAgent) {
                const agentTotal = categories.reduce((sum, c) => sum + c.count, 0);
                const maxCatCount = Math.max(...categories.map((c) => c.count));
                const catLabelLen = Math.max(...categories.map((c) => c.category.length));

                console.log(`\n┌─ ${agentId} (${agentTotal} memories)`);
                console.log("│");
                console.log(
                  `│  ${"Category".padEnd(catLabelLen)}  ${"Count".padStart(5)}  ${"".padEnd(BAR_WIDTH)}  ${"Importance".padStart(10)}`,
                );
                console.log(`│  ${"─".repeat(catLabelLen + 5 + BAR_WIDTH * 2 + 18)}`);
                for (const { category, count, avgImportance } of categories) {
                  const cat = category.padEnd(catLabelLen);
                  const cnt = String(count).padStart(5);
                  const pct = ((avgImportance * 100).toFixed(0) + "%").padStart(10);
                  console.log(
                    `│  ${cat}  ${cnt}  ${bar(count / maxCatCount)}  ${pct}  ${bar(avgImportance)}`,
                  );
                }
                console.log("└");
              }

              console.log(`\nAgents: ${byAgent.size} (${[...byAgent.keys()].join(", ")})`);
            }
            console.log("");
          } catch (err) {
            console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
            process.exitCode = 1;
          }
        });

      memory
        .command("sleep")
        .description("Run sleep cycle — consolidate memories with Pareto-based promotion")
        .option("--agent <id>", "Agent id (default: all agents)")
        .option("--dedup-threshold <n>", "Vector similarity threshold for dedup (default: 0.95)")
        .option("--pareto <n>", "Top N% for core memory (default: 0.2 = top 20%)")
        .option("--promotion-min-age <days>", "Min age in days before promotion (default: 7)")
        .option("--decay-threshold <n>", "Decay score threshold for pruning (default: 0.1)")
        .option("--decay-half-life <days>", "Base half-life in days (default: 30)")
        .option("--batch-size <n>", "Extraction batch size (default: 50)")
        .option("--delay <ms>", "Delay between extraction batches in ms (default: 1000)")
        .option("--max-semantic-pairs <n>", "Max LLM-checked semantic dedup pairs (default: 500)")
        .option("--concurrency <n>", "Parallel LLM calls — match OLLAMA_NUM_PARALLEL (default: 8)")
        .option(
          "--skip-semantic",
          "Skip LLM-based semantic dedup (Phase 1b) and conflict detection (Phase 1c)",
        )
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
            maxSemanticPairs?: string;
            concurrency?: string;
            skipSemantic?: boolean;
          }) => {
            console.log("\n🌙 Memory Sleep Cycle");
            console.log("═════════════════════════════════════════════════════════════");
            console.log("Seven-phase memory consolidation (Pareto-based):\n");
            console.log("  Phase 1:  Deduplication    — Merge near-duplicate memories");
            console.log(
              "  Phase 1b: Semantic Dedup   — LLM-based paraphrase detection (0.75–0.95 band)",
            );
            console.log("  Phase 1c: Conflict Detection — Resolve contradictory memories");
            console.log(
              "  Phase 2:  Pareto Scoring   — Calculate effective scores for all memories",
            );
            console.log("  Phase 3: Core Promotion   — Regular memories above threshold → core");
            console.log("  Phase 4: Core Demotion    — Core memories below threshold → regular");
            console.log("  Phase 5: Extraction       — Extract entities and categorize");
            console.log("  Phase 6: Decay & Pruning  — Remove stale low-importance memories");
            console.log("  Phase 7: Orphan Cleanup   — Remove disconnected nodes\n");

            try {
              // Validate sleep cycle CLI parameters before running
              const batchSize = opts.batchSize ? parseInt(opts.batchSize, 10) : undefined;
              const delay = opts.delay ? parseInt(opts.delay, 10) : undefined;
              const decayHalfLife = opts.decayHalfLife
                ? parseInt(opts.decayHalfLife, 10)
                : undefined;
              const decayThreshold = opts.decayThreshold
                ? parseFloat(opts.decayThreshold)
                : undefined;
              const pareto = opts.pareto ? parseFloat(opts.pareto) : undefined;
              const promotionMinAge = opts.promotionMinAge
                ? parseInt(opts.promotionMinAge, 10)
                : undefined;

              if (batchSize != null && (Number.isNaN(batchSize) || batchSize <= 0)) {
                console.error("Error: --batch-size must be greater than 0");
                process.exitCode = 1;
                return;
              }
              if (delay != null && (Number.isNaN(delay) || delay < 0)) {
                console.error("Error: --delay must be >= 0");
                process.exitCode = 1;
                return;
              }
              if (decayHalfLife != null && (Number.isNaN(decayHalfLife) || decayHalfLife <= 0)) {
                console.error("Error: --decay-half-life must be greater than 0");
                process.exitCode = 1;
                return;
              }
              if (
                decayThreshold != null &&
                (Number.isNaN(decayThreshold) || decayThreshold < 0 || decayThreshold > 1)
              ) {
                console.error("Error: --decay-threshold must be between 0 and 1");
                process.exitCode = 1;
                return;
              }
              if (pareto != null && (Number.isNaN(pareto) || pareto < 0 || pareto > 1)) {
                console.error("Error: --pareto must be between 0 and 1");
                process.exitCode = 1;
                return;
              }
              if (
                promotionMinAge != null &&
                (Number.isNaN(promotionMinAge) || promotionMinAge < 0)
              ) {
                console.error("Error: --promotion-min-age must be >= 0");
                process.exitCode = 1;
                return;
              }

              const maxSemanticPairs = opts.maxSemanticPairs
                ? parseInt(opts.maxSemanticPairs, 10)
                : undefined;
              if (
                maxSemanticPairs != null &&
                (Number.isNaN(maxSemanticPairs) || maxSemanticPairs <= 0)
              ) {
                console.error("Error: --max-semantic-pairs must be greater than 0");
                process.exitCode = 1;
                return;
              }

              const concurrency = opts.concurrency ? parseInt(opts.concurrency, 10) : undefined;
              if (concurrency != null && (Number.isNaN(concurrency) || concurrency <= 0)) {
                console.error("Error: --concurrency must be greater than 0");
                process.exitCode = 1;
                return;
              }

              await db.ensureInitialized();

              const result = await runSleepCycle(db, embeddings, extractionConfig, api.logger, {
                agentId: opts.agent,
                dedupThreshold: opts.dedupThreshold ? parseFloat(opts.dedupThreshold) : undefined,
                skipSemanticDedup: opts.skipSemantic === true,
                maxSemanticDedupPairs: maxSemanticPairs,
                llmConcurrency: concurrency,
                paretoPercentile: pareto,
                promotionMinAgeDays: promotionMinAge,
                decayRetentionThreshold: decayThreshold,
                decayBaseHalfLifeDays: decayHalfLife,
                decayCurves: Object.keys(cfg.decayCurves).length > 0 ? cfg.decayCurves : undefined,
                extractionBatchSize: batchSize,
                extractionDelayMs: delay,
                onPhaseStart: (phase) => {
                  const phaseNames: Record<string, string> = {
                    dedup: "Phase 1: Deduplication",
                    semanticDedup: "Phase 1b: Semantic Deduplication",
                    conflict: "Phase 1c: Conflict Detection",
                    pareto: "Phase 2: Pareto Scoring",
                    promotion: "Phase 3: Core Promotion",
                    extraction: "Phase 4: Extraction",
                    decay: "Phase 5: Decay & Pruning",
                    cleanup: "Phase 6: Orphan Cleanup",
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
                `   Conflicts:      ${result.conflict.pairsFound} pairs, ${result.conflict.resolved} resolved, ${result.conflict.invalidated} invalidated`,
              );
              console.log(
                `   Semantic Dedup: ${result.semanticDedup.pairsChecked} pairs checked, ${result.semanticDedup.duplicatesMerged} merged`,
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

      memory
        .command("index")
        .description(
          "Re-embed all memories and entities — use after changing embedding model/provider",
        )
        .option("--batch-size <n>", "Embedding batch size (default: 50)")
        .action(async (opts: { batchSize?: string }) => {
          const batchSize = opts.batchSize ? parseInt(opts.batchSize, 10) : 50;
          if (Number.isNaN(batchSize) || batchSize <= 0) {
            console.error("Error: --batch-size must be greater than 0");
            process.exitCode = 1;
            return;
          }

          console.log("\nMemory Neo4j — Reindex Embeddings");
          console.log("═════════════════════════════════════════════════════════════");
          console.log(`Model:      ${cfg.embedding.provider}/${cfg.embedding.model}`);
          console.log(`Dimensions: ${vectorDim}`);
          console.log(`Batch size: ${batchSize}\n`);

          try {
            const startedAt = Date.now();
            const result = await db.reindex((texts) => embeddings.embedBatch(texts), {
              batchSize,
              onProgress: (phase, done, total) => {
                if (phase === "drop-indexes" && done === 0) {
                  console.log("▶ Dropping old vector index…");
                } else if (phase === "memories") {
                  console.log(`   Memories: ${done}/${total}`);
                } else if (phase === "create-indexes" && done === 0) {
                  console.log("▶ Recreating vector index…");
                }
              },
            });

            const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
            console.log("\n═════════════════════════════════════════════════════════════");
            console.log(`✅ Reindex complete in ${elapsed}s — ${result.memories} memories`);
            console.log("");
          } catch (err) {
            console.error(
              `\n❌ Reindex failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            process.exitCode = 1;
          }
        });

      memory
        .command("cleanup")
        .description(
          "Retroactively apply the attention gate — find and remove low-substance memories",
        )
        .option("--execute", "Actually delete (default: dry-run preview)")
        .option("--all", "Include explicitly-stored memories (default: auto-capture only)")
        .option("--agent <id>", "Only clean up memories for a specific agent")
        .action(async (opts: { execute?: boolean; all?: boolean; agent?: string }) => {
          try {
            await db.ensureInitialized();

            // Fetch memories — by default only auto-capture (explicit stores are trusted)
            const conditions: string[] = [];
            if (!opts.all) {
              conditions.push("m.source = 'auto-capture'");
            }
            if (opts.agent) {
              conditions.push("m.agentId = $agentId");
            }
            const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
            const allMemories = await db.runQuery<{
              id: string;
              text: string;
              source: string;
            }>(
              `MATCH (m:Memory) ${where}
               RETURN m.id AS id, m.text AS text, COALESCE(m.source, 'unknown') AS source
               ORDER BY m.createdAt ASC`,
              opts.agent ? { agentId: opts.agent } : {},
            );

            // Strip channel metadata wrappers (same as the real pipeline) then gate
            const noise: Array<{ id: string; text: string; source: string }> = [];
            for (const mem of allMemories) {
              const stripped = stripMessageWrappers(mem.text);
              if (!passesAttentionGate(stripped)) {
                noise.push(mem);
              }
            }

            if (noise.length === 0) {
              console.log("\nNo low-substance memories found. Everything passes the gate.");
              return;
            }

            console.log(
              `\nFound ${noise.length}/${allMemories.length} memories that fail the attention gate:\n`,
            );

            for (const mem of noise) {
              const preview = mem.text.length > 80 ? `${mem.text.slice(0, 77)}...` : mem.text;
              console.log(`  [${mem.source}] "${preview}"`);
            }

            if (!opts.execute) {
              console.log(
                `\nDry run — ${noise.length} memories would be removed. Re-run with --execute to delete.\n`,
              );
              return;
            }

            // Delete in batch
            const deleted = await db.pruneMemories(noise.map((m) => m.id));
            console.log(`\nDeleted ${deleted} low-substance memories.\n`);
          } catch (err) {
            console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
            process.exitCode = 1;
          }
        });
    },
    { commands: [] }, // Adds subcommands to existing "memory" command, no conflict
  );
}
