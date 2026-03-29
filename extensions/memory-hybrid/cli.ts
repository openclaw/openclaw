import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { WorkingMemoryBuffer } from "./buffer.js";
import { generateMemorySummary } from "./capture.js";
import type { ChatModel } from "./chat.js";
import type { MemoryConfig } from "./config.js";
import { clusterBySimilarity, mergeFacts } from "./consolidate.js";
import type { MemoryDB } from "./database.js";
import type { Embeddings } from "./embeddings.js";
import type { GraphDB } from "./graph.js";
import { TaskPriority } from "./limiter.js";
import { hybridScore } from "./recall.js";
import { generateReflection } from "./reflection.js";
import type { MemoryTracer } from "./tracer.js";

export interface CliDeps {
  db: MemoryDB;
  embeddings: Embeddings;
  graphDB: GraphDB;
  workingMemory: WorkingMemoryBuffer;
  chatModel: ChatModel;
  tracer: MemoryTracer;
  cfg: MemoryConfig;
}

export function registerCli(api: OpenClawPluginApi, deps: CliDeps) {
  const { db, embeddings, graphDB, workingMemory, chatModel, tracer, cfg } = deps;

  api.registerCli(
    ({ program }) => {
      const memory = program.command("ltm").description("Hybrid memory plugin commands");

      memory
        .command("list")
        .description("Show memory count")
        .action(async () => {
          const count = await db.count();
          console.log(`Total memories: ${count}`);
        });

      memory
        .command("search")
        .description("Search memories")
        .argument("<query>", "Search query")
        .option("--limit <n>", "Max results", "5")
        .action(async (query, opts) => {
          const limit = parseInt(opts.limit);
          const vector = await embeddings.embed(query);
          const rawResults = await db.search(vector, limit, 0.3);
          const scored = await hybridScore(rawResults, graphDB);
          const limited = scored.slice(0, limit);

          const output = limited.map((r) => ({
            id: r.entry.id,
            text: r.entry.text,
            category: r.entry.category,
            importance: r.entry.importance,
            vectorScore: r.vectorScore,
            finalScore: r.finalScore,
          }));

          tracer.traceRecall(
            query,
            output.map((s) => ({
              id: s.id,
              text: s.text,
              score: s.finalScore,
            })),
          );

          console.log(JSON.stringify(output, null, 2));
        });

      memory
        .command("graph")
        .description("Show knowledge graph stats")
        .action(async () => {
          await graphDB.load();
          console.log(`Graph: ${graphDB.nodeCount} nodes, ${graphDB.edgeCount} edges`);
          if (graphDB.nodeCount > 0) {
            console.log("\nNodes:");
            for (const node of graphDB.nodes.values()) {
              console.log(
                `  - [${node.type}] ${node.id}${node.description ? ` (${node.description})` : ""}`,
              );
            }
          }
        });

      memory
        .command("stats")
        .description("Show memory statistics")
        .action(async () => {
          const count = await db.count();
          await graphDB.load();
          const bufStats = workingMemory.stats();
          console.log(`Memories: ${count}`);
          console.log(`Graph: ${graphDB.nodeCount} nodes, ${graphDB.edgeCount} edges`);
          console.log(
            `Working Memory Buffer: ${bufStats.total} entries (${bufStats.promoted} promoted, ${bufStats.pending} pending)`,
          );
          console.log(`Provider: ${cfg.embedding.provider}`);
          console.log(`Embedding model: ${cfg.embedding.model}`);
          console.log(`Chat model: ${cfg.chatModel}`);
        });

      memory
        .command("timeline")
        .description("Show memories sorted by event date (temporal view)")
        .option("--limit <n>", "Max results", "20")
        .action(async (opts) => {
          const allMemories = await db.listMetadata();
          const withDates = allMemories
            .filter((m) => m.happenedAt && m.happenedAt !== "")
            .sort((a, b) => {
              const dateA = Date.parse(a.happenedAt ?? "");
              const dateB = Date.parse(b.happenedAt ?? "");
              if (isNaN(dateA)) return 1;
              if (isNaN(dateB)) return -1;
              return dateB - dateA; // newest first
            })
            .slice(0, parseInt(opts.limit));

          if (withDates.length === 0) {
            console.log("No temporal memories found yet. Chat more to build your timeline! ⏳");
            return;
          }

          console.log(`📅 Memory Timeline (${withDates.length} events):\n`);
          for (const m of withDates) {
            const expired = m.validUntil && Date.parse(m.validUntil) < Date.now();
            const emoji =
              m.emotionalTone === "happy" || m.emotionalTone === "excited"
                ? "😊"
                : m.emotionalTone === "stressed" ||
                    m.emotionalTone === "frustrated" ||
                    m.emotionalTone === "angry"
                  ? "😤"
                  : m.emotionalTone === "sad"
                    ? "😢"
                    : m.emotionalTone === "curious"
                      ? "🤔"
                      : "📌";
            const expiryTag = expired
              ? " [EXPIRED]"
              : m.validUntil
                ? ` [until ${m.validUntil}]`
                : "";
            console.log(`  ${m.happenedAt} ${emoji} ${m.text}${expiryTag}`);
          }
        });

      memory
        .command("consolidate")
        .description("Merge similar memories into stronger facts (sleep mode)")
        .option("--threshold <n>", "Similarity threshold (0-1)", "0.85")
        .option("--prune <n>", "Prune unused memories older than N days (default: 90)", "90")
        .option("--dry-run", "Show what would be merged without applying")
        .action(async (opts) => {
          console.log("🧠 Memory Consolidation starting...\n");

          if (opts.prune) {
            const days = parseInt(opts.prune);
            if (days > 0) {
              if (opts.dryRun) {
                console.log(`✂️ [DRY RUN] Would prune unused memories older than ${days} days.`);
              } else {
                const deleted = await db.deleteOldUnused(days);
                if (deleted > 0) {
                  console.log(
                    `✂️ Synaptic Pruning: Deleted ${deleted} unused memories (> ${days} days old).`,
                  );
                }
              }
            }
          }

          const allMemories = await db.listAll();
          console.log(`Found ${allMemories.length} total memories.`);

          if (allMemories.length < 2) {
            console.log("Not enough memories to consolidate.");
            return;
          }

          const threshold = parseFloat(opts.threshold);
          const clusters = clusterBySimilarity(allMemories, threshold);

          if (clusters.length === 0) {
            console.log("No similar memory clusters found. Memory is clean! ✅");
            return;
          }

          console.log(`Found ${clusters.length} cluster(s) to merge:\n`);

          let totalMerged = 0;
          let totalCreated = 0;

          for (const cluster of clusters) {
            const texts = cluster.map((c) => c.text);
            console.log(`📦 Cluster (${cluster.length} items):`);
            if (opts.dryRun) {
              for (const t of texts) {
                console.log(`   - "${t.slice(0, 80)}${t.length > 80 ? "..." : ""}"`);
              }
              console.log("   → [DRY RUN] Would merge these.\n");
              continue;
            }

            const merged = await mergeFacts(texts, chatModel);
            if (!merged) {
              console.log("   → ⚠️ LLM merge failed, skipping.\n");
              continue;
            }

            console.log(`   → ✅ Merged into: "${merged}"`);

            const clusterEntries = await Promise.all(cluster.map((c) => db.getById(c.id)));
            const validEntries = clusterEntries.filter(
              (e): e is NonNullable<typeof e> => e != null,
            );

            const bestImportance = Math.max(0.85, ...validEntries.map((e) => e.importance));
            const categories = validEntries.map((e) => e.category);
            const bestCategory =
              categories.find((c) => c === "decision") ??
              categories.find((c) => c === "preference") ??
              categories.find((c) => c === "entity") ??
              categories.find((c) => c === "fact") ??
              "fact";
            const bestHappenedAt =
              validEntries
                .map((e) => e.happenedAt)
                .filter((h): h is string => !!h)
                .sort()[0] ?? null;
            const bestValidUntil =
              validEntries
                .map((e) => e.validUntil)
                .filter((v): v is string => !!v)
                .sort()
                .reverse()[0] ?? null;
            const emotionalEntries = validEntries.filter(
              (e) => e.emotionalTone && e.emotionalTone !== "neutral",
            );
            const bestEmotionalTone =
              emotionalEntries.length > 0 ? emotionalEntries[0].emotionalTone : "neutral";
            const bestEmotionScore =
              emotionalEntries.length > 0
                ? emotionalEntries.reduce(
                    (max, e) =>
                      Math.abs(e.emotionScore ?? 0) > Math.abs(max) ? (e.emotionScore ?? 0) : max,
                    0,
                  )
                : 0;

            const vector = await embeddings.embed(merged, TaskPriority.LOW);
            const summary = await generateMemorySummary(merged, chatModel);

            await db.store({
              text: merged,
              vector,
              importance: bestImportance,
              category: bestCategory,
              happenedAt: bestHappenedAt,
              validUntil: bestValidUntil,
              summary,
              emotionalTone: bestEmotionalTone,
              emotionScore: bestEmotionScore,
            });

            for (const item of cluster) {
              await db.delete(item.id);
            }

            totalMerged += cluster.length;
            totalCreated++;
            console.log("");
          }

          if (!opts.dryRun) {
            console.log(
              `\n✅ Done! Merged ${totalMerged} memories into ${totalCreated} consolidated facts.`,
            );
          }
        });

      memory
        .command("reflect")
        .description("Generate a high-level user profile from all memories")
        .action(async () => {
          const allMemories = await db.listMetadata();
          console.log(`\n🪞 Reflecting on ${allMemories.length} memories...\n`);

          const result = await generateReflection(
            allMemories.map((m) => ({
              text: m.text,
              category: m.category,
              importance: m.importance,
              recallCount: m.recallCount,
              emotionalTone: m.emotionalTone,
              emotionScore: m.emotionScore,
              happenedAt: m.happenedAt,
            })),
            chatModel,
            TaskPriority.NORMAL,
          );

          console.log(`📝 Summary:\n${result.summary}\n`);
          if (result.patterns.length > 0) {
            console.log("🔍 Patterns:");
            for (const p of result.patterns) {
              console.log(`   - ${p}`);
            }
          }
          console.log(`\n(Analyzed ${result.memoriesAnalyzed} memories)`);
        });
    },
    { commands: ["ltm"] },
  );
}
