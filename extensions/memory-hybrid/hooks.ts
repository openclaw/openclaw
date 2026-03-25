import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { WorkingMemoryBuffer } from "./buffer.js";
import {
  shouldCapture,
  detectCategory,
  smartCapture,
  formatRadarContext,
  generateMemorySummary,
  escapeMemoryForPrompt,
} from "./capture.js";
import type { ChatModel } from "./chat.js";
import type { MemoryCategory } from "./config.js";
import type { MemoryDB } from "./database.js";
import type { DreamService } from "./dream.js";
import type { Embeddings } from "./embeddings.js";
import type { GraphDB } from "./graph.js";
import { extractGraphFromBatch } from "./graph.js";
import { MemoryQueue } from "./queue.js";
import { hybridScore, getGraphEnrichment } from "./recall.js";
import type { ConversationStack } from "./stack.js";
import { tracer } from "./tracer.js";

export interface HookDeps {
  db: MemoryDB;
  embeddings: Embeddings;
  chatModel: ChatModel;
  graphDB: GraphDB;
  dreamService: DreamService;
  conversationStack: ConversationStack;
  workingMemory: WorkingMemoryBuffer;
  cfg: any;
}

const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
let lastPruneTime = 0;

export function registerHooks(api: OpenClawPluginApi, deps: HookDeps) {
  const {
    db,
    embeddings,
    chatModel,
    graphDB,
    dreamService,
    conversationStack,
    workingMemory,
    cfg,
  } = deps;
  const memoryQueue = new MemoryQueue({ delayMs: 1500 });

  // ======================================================================
  // Lifecycle: Auto-Recall (before_agent_start)
  // ======================================================================
  if (cfg.autoRecall) {
    api.on("before_agent_start", async (event, ctx) => {
      if (!event.prompt || event.prompt.length < 5) return;

      if (
        ctx?.trigger === "system" ||
        ctx?.trigger === "heartbeat" ||
        ctx?.trigger === "cron" ||
        ctx?.trigger === "memory"
      ) {
        return;
      }

      const nPrompt = event.prompt.trim().toLowerCase();
      if (nPrompt.startsWith("/")) return;
      if (
        /^(hi|hello|hey|start|new chat|привіт|вітаю|почнемо|started a new chat|welcome|що нового)[\s.!?]*$/i.test(
          nPrompt,
        ) ||
        nPrompt.includes("started a new chat") ||
        nPrompt.includes("session started")
      )
        return;

      try {
        const isDeepTopic =
          /trauma|childhood|fear|secret|life|history|травм|дитинств|страх|таємниц|життя|історія/i.test(
            nPrompt,
          );
        const limit = isDeepTopic ? 30 : 5;

        const vector = await embeddings.embed(event.prompt);
        const rawResults = await db.searchWithAMHR(vector, limit, graphDB, 0.3);

        const scored = await hybridScore(rawResults, graphDB);
        const finalScored = scored.slice(0, limit);

        api.logger.info(`memory-hybrid: injecting ${finalScored.length} memories`);

        const radarContext = formatRadarContext(
          finalScored.map((r) => ({
            id: r.entry.id,
            category: r.entry.category as MemoryCategory,
            summary: r.entry.summary,
            text: r.entry.text,
          })),
        );

        const graphInfo = await getGraphEnrichment(finalScored, graphDB);
        let context = radarContext;
        if (graphInfo) {
          context = context.replace("</star-map>", graphInfo + "\n</star-map>");
        }

        db.incrementRecallCount(finalScored.map((r) => r.entry.id));

        tracer.traceRecall(
          event.prompt,
          finalScored.map((s) => ({
            id: s.entry.id,
            text: s.entry.text,
            score: s.finalScore,
          })),
        );

        return { prependContext: context };
      } catch (err) {
        api.logger.warn(`memory-hybrid: recall failed: ${String(err)}`);
      }
    });
  }

  // ======================================================================
  // Lifecycle: Auto-Capture (agent_end)
  // ======================================================================
  api.on("agent_end", async (event, ctx) => {
    if (
      ctx?.trigger !== "system" &&
      ctx?.trigger !== "heartbeat" &&
      ctx?.trigger !== "cron" &&
      ctx?.trigger !== "memory" &&
      event.messages &&
      event.messages.length > 0
    ) {
      dreamService.registerInteraction();
    }

    if (cfg.autoCapture) {
      if (
        ctx?.trigger === "system" ||
        ctx?.trigger === "heartbeat" ||
        ctx?.trigger === "cron" ||
        ctx?.trigger === "memory"
      ) {
        return;
      }

      if (!event.success || !event.messages || event.messages.length === 0) {
        return;
      }

      memoryQueue.push("auto-capture", async () => {
        try {
          const userTexts: string[] = [];
          const assistantTexts: string[] = [];

          for (const msg of event.messages) {
            if (!msg || typeof msg !== "object") continue;
            const msgObj = msg as Record<string, unknown>;
            const role = msgObj.role;
            const content = msgObj.content;

            const texts =
              role === "user" ? userTexts : role === "assistant" ? assistantTexts : null;
            if (!texts) continue;

            if (typeof content === "string") {
              texts.push(content);
              continue;
            }

            if (Array.isArray(content)) {
              for (const block of content) {
                if (
                  block &&
                  typeof block === "object" &&
                  "type" in block &&
                  (block as Record<string, unknown>).type === "text" &&
                  "text" in block &&
                  typeof (block as Record<string, unknown>).text === "string"
                ) {
                  texts.push((block as Record<string, unknown>).text as string);
                }
              }
            }
          }

          const lastUserMsg = userTexts.length > 0 ? userTexts[userTexts.length - 1] : "";
          const lastAssistantMsg =
            assistantTexts.length > 0 ? assistantTexts[assistantTexts.length - 1] : "";

          if (lastUserMsg.length > 10 || lastAssistantMsg.length > 10) {
            try {
              await conversationStack.push(lastUserMsg, lastAssistantMsg, chatModel);
            } catch (err) {
              api.logger.warn(
                `memory-hybrid: stack compression failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }

          if (cfg.smartCapture && userTexts.length > 0) {
            const isTrivial =
              lastUserMsg.length < 15 ||
              /^(ok|yes|no|y|n|sure|thanks|thx|thank you|lol|haha|hmm|yep|nope|\u{1F44D}|done|got it|cool|nice|great|good|fine|agreed|alright|\u{043E}\u{043A}|\u{0442}\u{0430}\u{043A}|\u{043D}\u{0456}|\u{0434}\u{044F}\u{043A}\u{0443}\u{044E}|\u{044F}\u{0441}\u{043D}\u{043E}|\u{0434}\u{043E}\u{0431}\u{0440}\u{0435})\s*[.!?]?$/iu.test(
                lastUserMsg.trim(),
              );

            const result = isTrivial
              ? { shouldStore: false as const, facts: [] }
              : await smartCapture(lastUserMsg, lastAssistantMsg || undefined, chatModel);

            if (result.shouldStore && result.facts.length > 0) {
              const factsToProcess = result.facts.slice(0, 5);
              const vectors = await embeddings.embedBatch(factsToProcess.map((f) => f.text));

              let stored = 0;
              for (let i = 0; i < factsToProcess.length; i++) {
                const fact = factsToProcess[i];
                const vector = vectors[i];

                try {
                  let skipStore = false;
                  if (fact.isCorrection) {
                    const broadExisting = await db.search(vector, 3, 0.6);
                    if (broadExisting.length > 0) {
                      const topMatch = broadExisting[0];
                      const analysis = await chatModel.checkForContradiction(
                        topMatch.entry.text,
                        fact.text,
                      );
                      if (analysis.action === "update") {
                        await db.delete(topMatch.entry.id);
                        api.logger.info(
                          `memory-hybrid: [Correction] auto-deleted old memory ${topMatch.entry.id} (replaced by new fact)`,
                        );
                      } else if (analysis.action === "ignore_new") {
                        skipStore = true;
                      }
                    }
                  } else {
                    const existing = await db.search(vector, 1, 0.95);
                    if (existing.length > 0) skipStore = true;
                  }

                  if (skipStore) continue;

                  const summary = fact.summary || fact.text.slice(0, 150);
                  await db.store({
                    text: fact.text,
                    vector,
                    importance: fact.importance,
                    category: fact.category,
                    happenedAt: fact.happenedAt ?? null,
                    validUntil: fact.validUntil ?? null,
                    summary,
                    emotionalTone: fact.emotionalTone ?? "neutral",
                    emotionScore: fact.emotionScore ?? 0,
                  });
                  tracer.traceStore(fact.text, fact.category, "auto-capture");
                  stored++;
                } catch (err) {
                  api.logger.warn(
                    `memory-hybrid: smart-capture fact skip: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              }

              if (stored > 0) {
                api.logger.info(`memory-hybrid: smart-captured ${stored} facts`);

                const factTexts = factsToProcess.map((f) => f.text);
                try {
                  const graph = await extractGraphFromBatch(factTexts, chatModel);
                  if (graph.nodes.length > 0 || graph.edges.length > 0) {
                    await graphDB.modify(() => {
                      for (const n of graph.nodes) graphDB.addNode(n);
                      for (const e of graph.edges) graphDB.addEdge(e);
                    });
                    tracer.traceGraph(graph.nodes.length, graph.edges.length);
                    api.logger.info(
                      `memory-hybrid: batch graph updated (+${graph.nodes.length} nodes, +${graph.edges.length} edges)`,
                    );
                  }
                } catch (err) {
                  api.logger.warn(`memory-hybrid: batch graph extraction fatal: ${String(err)}`);
                }
              }
            }
          }

          if (!cfg.smartCapture || userTexts.length === 0 || lastUserMsg.length >= 15) {
            const toCapture = userTexts.filter(
              (text) => text && shouldCapture(text, { maxChars: cfg.captureMaxChars }),
            );

            if (toCapture.length > 0) {
              let storedRuleBased = 0;
              for (const text of toCapture.slice(0, 3)) {
                const category = detectCategory(text);
                const importance = category === "entity" || category === "decision" ? 0.85 : 0.7;

                const promotion = workingMemory.add(text, importance, category);
                if (!promotion.promoted) continue;

                const vector = await embeddings.embed(text);
                const existing = await db.search(vector, 1, 0.95);
                if (existing.length > 0) continue;

                const summary = await generateMemorySummary(text, chatModel);
                await db.store({ text, vector, importance, category, summary });
                storedRuleBased++;
              }

              if (storedRuleBased > 0) {
                api.logger.info(
                  `memory-hybrid: auto-captured ${storedRuleBased} memories (buffer: ${workingMemory.size} entries)`,
                );
              }
            }
          }
        } catch (err) {
          api.logger.warn(`memory-hybrid: background capture failed: ${String(err)}`);
        }
      });

      if (Date.now() - lastPruneTime > PRUNE_INTERVAL_MS) {
        lastPruneTime = Date.now();
        try {
          const flushed = await db.flushRecallCounts();
          if (flushed > 0) {
            api.logger.info(`memory-hybrid: flushed ${flushed} recall count deltas`);
          }

          const deleted = await db.deleteOldUnused(90);
          if (deleted > 0) {
            api.logger.info(`memory-hybrid: auto-pruned ${deleted} unused memories (>90 days)`);
          }
        } catch (err) {
          api.logger.warn(
            `memory-hybrid: pruning/flush failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  });
}
