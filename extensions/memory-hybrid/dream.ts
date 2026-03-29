import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ChatModel } from "./chat.js";
import { clusterBySimilarity, mergeFacts, mergeFactsBatch } from "./consolidate.js";
import type { MemoryDB } from "./database.js";
import type { Embeddings } from "./embeddings.js";
import type { GraphDB } from "./graph.js";
import { TaskPriority } from "./limiter.js";
import { MemoryTracer, type Logger } from "./tracer.js";
import { escapePrompt } from "./utils.js";

const IDLE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes idle
const LOOP_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes
const DREAM_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hours cooldown after a successful dream

export class DreamService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastInteractionTime: number = Date.now();
  private lastDreamTime: number = 0;
  private isDreaming = false;
  private readonly logger: Logger;

  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly db: MemoryDB,
    private readonly embeddings: Embeddings,
    private readonly graphDB: GraphDB,
    private readonly chatModel: ChatModel,
    private readonly tracer: MemoryTracer,
  ) {
    this.logger = api.logger;
  }

  /** Call this whenever the user sends a message */
  public registerInteraction(): void {
    this.lastInteractionTime = Date.now();
  }

  public start(): void {
    if (this.timer) {
      this.logger.info("memory-hybrid: Dream Service is already running. Skipping start.");
      return;
    }
    this.logger.info("memory-hybrid: Dream Service initialized.");
    this.timer = setInterval(() => void this.tick(), LOOP_INTERVAL_MS);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.isDreaming) return;

    const now = Date.now();
    const timeSinceLastInteraction = now - this.lastInteractionTime;
    const timeSinceLastDream = now - this.lastDreamTime;

    if (timeSinceLastInteraction < IDLE_THRESHOLD_MS) {
      return; // User is still active
    }

    if (timeSinceLastDream < DREAM_COOLDOWN_MS) {
      return; // Cooling down
    }

    this.isDreaming = true;
    this.lastDreamTime = now; // Mark attempt/start early to avoid spam if crash occurs
    try {
      this.logger.info("memory-hybrid: [Dream Mode] Entering Synthetic Sleep (NREM Phase 1)...");

      // Phase 1: Synaptic Pruning (Garbage Collection)
      const deleted = await this.db.cleanupTrash();
      if (deleted > 0) {
        this.logger.info(`memory-hybrid: [Dream Mode] Pruned ${deleted} noisy/trash memories.`);
      }

      // Phase 2: Empathy Profiling
      this.logger.info(
        "memory-hybrid: [Dream Mode] Generating Empathy Profile (Deep Sleep Phase 2)...",
      );
      await this.generateEmpathyProfile();

      // Phase 3: Semantic Consolidation (Merging redundant memories)
      this.logger.info("memory-hybrid: [Dream Mode] Consolidating Knowledge (REM Phase 3)...");
      await this.consolidateKnowledge();

      // Phase 4: Knowledge Pulse (Syncing and Optimization)
      this.logger.info("memory-hybrid: [Dream Mode] Knowledge Pulse (Phase 4)...");
      await this.pulseKnowledge();

      this.logger.info(
        "memory-hybrid: [Dream Mode] Synthetic Sleep complete - brain is refreshed.",
      );
    } catch (err) {
      this.logger.warn(`memory-hybrid: [Dream Mode] Error during sleep cycle: ${String(err)}`);
    } finally {
      this.isDreaming = false;
    }
  }

  private async generateEmpathyProfile(): Promise<void> {
    const memories = await this.db.getMemoriesByCategory(["preference", "decision", "other"], 50);
    if (memories.length < 3) return;

    // Use a maximum fact count to prevent token blowout (15k limit) without slicing mid-sentence
    let facts = "";
    for (const m of memories) {
      const escapedText = escapePrompt(m.text);
      if (facts.length + escapedText.length + 1 > 10000) break;
      facts += escapedText + "\n";
    }

    const prompt = `Analyze these facts about the user and generate a concise 2-sentence Empathy Profile summarizing their current mental state, core interests, and communication preferences. Return ONLY the 2 sentences.\n\nFacts:\n${facts}`;

    const profileText = await this.chatModel.complete(
      [{ role: "user", content: prompt }],
      false,
      TaskPriority.LOW,
    );
    if (!profileText || profileText.length < 10) return;

    const vector = await this.embeddings.embed(profileText, TaskPriority.LOW);

    // Store-Before-Delete: create new profile first, then clean up old ones
    await this.db.store({
      text: `[EMPATHY PROFILE] ${profileText.trim()}`,
      importance: 0.95,
      category: "preference",
      vector,
      happenedAt: null,
      validUntil: null,
      summary: "Current Empathy Profile (Refreshed during Sleep)",
      emotionalTone: "neutral",
      emotionScore: 0,
    });

    // Now safe to delete old profiles (new one is already persisted)
    const oldProfiles = await this.db.getMemoriesByCategory(["preference"], 200);
    for (const m of oldProfiles) {
      if (
        m.text.startsWith("[EMPATHY PROFILE]") &&
        m.text !== `[EMPATHY PROFILE] ${profileText.trim()}`
      ) {
        await this.db.delete(m.id);
      }
    }
  }

  private async consolidateKnowledge(): Promise<void> {
    // 1. Fetch memories for clustering
    // To stay within 15k context and RAM limits, we only consider up to 200 items per sleep cycle.
    let all = await this.db.listAll();
    if (all.length > 200) {
      all = all.slice(-200);
    }
    if (all.length < 5) return;

    // 2. High-threshold clustering (0.92+ for safety)
    const clusters = clusterBySimilarity(all, 0.92);
    const validClusters: Array<Array<{ id: string; text: string; category: string }>> = [];

    for (const cluster of clusters) {
      if (cluster.length < 2) continue;

      // SAFETY: Check if they are in the same category
      const cats = cluster.map((c) => all.find((a) => a.id === c.id)?.category);
      const uniqueCats = new Set(cats);
      if (uniqueCats.size > 1) continue;

      // Entity Check (Hallucination Guard)
      const entitySets: Set<string>[] = [];
      for (const item of cluster) {
        const found = await this.graphDB.findEdgesForTexts([item.text]);
        entitySets.push(new Set(found.flatMap((e) => [e.source, e.target])));
      }

      const allHaveEntities = entitySets.every((set) => set.size > 0);
      if (allHaveEntities && entitySets.length > 1) {
        let hasOverlap = false;
        const setA = entitySets[0]!;
        for (let i = 1; i < entitySets.length; i++) {
          const setB = entitySets[i]!;
          for (const item of setA) {
            if (setB.has(item)) hasOverlap = true;
          }
        }
        if (!hasOverlap) continue;
      }

      validClusters.push(cluster.map((c) => ({ ...c, category: cats[0] ?? "other" })));
    }

    if (validClusters.length === 0) return;

    // 3. Batch Merge! (High TPM / Low RPM)
    const clusterTexts = validClusters.map((c) => c.map((item) => item.text));
    const mergedResults = await mergeFactsBatch(clusterTexts, this.chatModel);

    // 4. Batch Embed! (Optimize API usage)
    const validMergedIndices: number[] = [];
    const textsToEmbed: string[] = [];
    for (let i = 0; i < mergedResults.length; i++) {
      if (mergedResults[i]) {
        validMergedIndices.push(i);
        textsToEmbed.push(mergedResults[i]!);
      }
    }

    if (textsToEmbed.length === 0) return;
    const vectors = await this.embeddings.embedBatch(textsToEmbed, TaskPriority.LOW);

    let mergedCount = 0;
    for (let i = 0; i < validMergedIndices.length; i++) {
      const clusterIdx = validMergedIndices[i];
      const merged = textsToEmbed[i];
      const vector = vectors[i];
      const cluster = validClusters[clusterIdx];
      const category = cluster[0].category;

      // Store new, delete old
      await this.db.store({
        text: merged,
        importance: 0.8,
        category: category ?? "fact",
        vector,
        happenedAt: null,
        validUntil: null,
        summary: "Consolidated Memory",
        emotionalTone: "neutral",
        emotionScore: 0,
      });

      for (const item of cluster) {
        await this.db.delete(item.id);
      }
      mergedCount++;
    }

    if (mergedCount > 0) {
      // The original instruction snippet had `c.clustersFound` which is not defined here.
      // I'm assuming it meant the number of clusters that were successfully merged.
      this.logger.info(
        `[memory-hybrid] Dream Cycle: Phase 1 (Consolidation) - Merged ${mergedCount} clusters.`,
      );
    }
  }

  private async pulseKnowledge(): Promise<void> {
    // 1. Flush recall counts (persists importance reinforcement)
    const flushed = await this.db.flushRecallCounts();
    if (flushed > 0) {
      this.logger.info(`memory-hybrid: Persisted recall counts for ${flushed} memories.`);
    }

    // 2. Compact Knowledge Graph
    await this.graphDB.compact();

    // 3. Cleanup very old unused memories (Synaptic Pruning)
    const pruned = await this.db.deleteOldUnused(30); // 30 days unused
    if (pruned > 0) {
      this.logger.info(`memory-hybrid: Pruned ${pruned} long-term unused memories.`);
    }
  }
}
