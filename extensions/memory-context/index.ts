import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { completeSimple, getModel } from "@mariozechner/pi-ai";
import { sanitizeToolUseResultPairing } from "../../src/agents/session-transcript-repair.js";
import {
  archiveCompactedMessages,
  scheduleKnowledgeExtraction,
} from "./src/core/compaction-bridge.js";
import { memoryContextConfigSchema, type MemoryContextConfig } from "./src/core/config.js";
import { createEmbeddingProvider } from "./src/core/embedding.js";
import { KnowledgeStore } from "./src/core/knowledge-store.js";
import { mmrRerank, type MMRCandidate } from "./src/core/mmr.js";
import { buildRecalledContextBlock } from "./src/core/recall-format.js";
import { maybeRedact } from "./src/core/redaction.js";
import { SYSTEM_PREFIX_RE, stripChannelPrefix } from "./src/core/shared.js";
import { smartTrim, type MessageLike } from "./src/core/smart-trim.js";
import { WarmStore } from "./src/core/store.js";

type RuntimeState = {
  config: MemoryContextConfig;
  rawStore: WarmStore;
  knowledgeStore: KnowledgeStore;
};

const runtimes = new Map<string, Promise<RuntimeState>>();
const cachedPromptBySession = new Map<string, string>();
const RECALLED_CONTEXT_MARKER = '<recalled-context source="memory-context">';

type HookCtx = {
  sessionId?: string;
  sessionKey?: string;
  compactionModel?: {
    provider: string;
    id: string;
    api: string;
  };
  compactionApiKey?: string;
};

function asMessageArray(value: unknown): AgentMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value as AgentMessage[];
}

function extractText(msg: AgentMessage): string {
  const raw = (msg as { content?: unknown }).content;
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw
      .map((block) => {
        if (!block || typeof block !== "object") {
          return "";
        }
        const typed = block as { type?: unknown; text?: unknown };
        return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function resolveSessionId(ctx: HookCtx): string {
  return ctx.sessionId || ctx.sessionKey || "default";
}

/**
 * Extract search query from last 2-3 user messages (broader keyword coverage).
 * Skips channel system-prefix messages and recalled-context blocks.
 */
function extractQueryFromRecentUserMessages(messages: AgentMessage[]): string {
  const userMessages: string[] = [];
  for (let i = messages.length - 1; i >= 0 && userMessages.length < 3; i--) {
    const msg = messages[i];
    if ((msg as { role?: string }).role !== "user") {
      continue;
    }
    const text = extractText(msg);
    if (!text.trim() || text.includes(RECALLED_CONTEXT_MARKER)) {
      continue;
    }
    // Skip channel-injected system prefix messages (e.g. Feishu metadata)
    if (SYSTEM_PREFIX_RE.test(text.trim())) {
      continue;
    }
    const content = stripChannelPrefix(text).trim();
    if (!content) {
      continue;
    }
    userMessages.unshift(content);
  }
  return userMessages.join(" ").trim();
}

function estimateMessageTokens(msg: MessageLike): number {
  return Math.max(1, Math.ceil(extractText(msg as AgentMessage).length / 3));
}

/**
 * Create an LLM call function for knowledge extraction using the compaction
 * model exposed via hook context. Returns undefined if model/apiKey unavailable.
 */
function createKnowledgeExtractionLlmCall(
  ctx: HookCtx,
): ((prompt: string) => Promise<string>) | undefined {
  const modelMeta = ctx.compactionModel;
  const apiKey = ctx.compactionApiKey;
  if (!modelMeta || !apiKey) {
    return undefined;
  }
  // Resolve full Model object from provider registry for type safety
  let resolvedModel: Parameters<typeof completeSimple>[0];
  try {
    resolvedModel = getModel(modelMeta.provider as any, modelMeta.id as any);
  } catch {
    // Model not in static registry — construct minimal compatible object
    resolvedModel = { provider: modelMeta.provider, id: modelMeta.id, api: modelMeta.api } as any;
  }
  return async (prompt: string) => {
    try {
      const res = await completeSimple(
        resolvedModel,
        {
          messages: [
            {
              role: "user",
              content: prompt,
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey,
          maxTokens: 2000,
          reasoning: "low",
        },
      );

      if (res.stopReason === "error") {
        return "";
      }

      return res.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
    } catch {
      return "";
    }
  };
}

/**
 * Non-blocking archive of trimmed messages to Raw Store.
 * Uses queueMicrotask to avoid blocking the recall path.
 */
function archiveTrimmedMessagesAsync(
  trimmed: MessageLike[],
  rawStore: WarmStore,
  redaction: boolean,
): void {
  if (trimmed.length === 0) {
    return;
  }
  queueMicrotask(() => {
    void (async () => {
      try {
        for (const msg of trimmed) {
          const role = msg.role;
          if (role !== "user" && role !== "assistant") {
            continue;
          }
          const text = extractText(msg as AgentMessage);
          if (!text.trim() || text.includes(RECALLED_CONTEXT_MARKER)) {
            continue;
          }
          const cleaned = stripChannelPrefix(text);
          if (!cleaned) {
            continue;
          }
          const archived = maybeRedact(cleaned, redaction);
          if (rawStore.isArchived(role, archived)) {
            continue;
          }
          await rawStore.addSegmentLite({ role, content: archived });
        }
      } catch (err) {
        console.warn(`memory-context: async archive of trimmed messages failed: ${String(err)}`);
      }
    })();
  });
}

async function getOrCreateRuntime(api: OpenClawPluginApi, ctx: HookCtx): Promise<RuntimeState> {
  const sessionId = resolveSessionId(ctx);
  const existing = runtimes.get(sessionId);
  if (existing) {
    return existing;
  }

  const runtimePromise = (async () => {
    const config = memoryContextConfigSchema.parse(api.pluginConfig ?? {});
    const embedding = await createEmbeddingProvider(api.config, config.embeddingModel);
    const rawStore = new WarmStore({
      sessionId,
      sessionKey: ctx.sessionKey,
      embedding,
      // KnowledgeStore and WarmStore share the same directory intentionally:
      // KnowledgeStore writes knowledge.jsonl, WarmStore writes segments.jsonl — no collision.
      coldStore: { path: config.storagePath },
      maxSegments: config.maxSegments,
      crossSession: config.crossSession,
      eviction: {
        enabled: config.evictionDays > 0,
        maxAgeDays: config.evictionDays,
      },
      vectorPersist: config.vectorPersist,
    });
    const knowledgeStore = new KnowledgeStore(config.storagePath);

    await rawStore.init();
    await knowledgeStore.init();

    return {
      config,
      rawStore,
      knowledgeStore,
    };
  })();

  runtimes.set(sessionId, runtimePromise);
  return runtimePromise;
}

const memoryContextPlugin = {
  id: "memory-context",
  name: "Memory (Context)",
  description: "Compaction-aware conversation memory with hybrid search and recall injection",
  kind: "memory" as const,
  configSchema: memoryContextConfigSchema,
  register(api: OpenClawPluginApi) {
    api.on("before_agent_start", (event, ctx) => {
      const sessionId = resolveSessionId(ctx);
      cachedPromptBySession.set(sessionId, stripChannelPrefix(event.prompt));
    });

    api.on("before_prompt_build", async (event, ctx) => {
      const runtime = await getOrCreateRuntime(api, ctx);
      if (!runtime.config.autoRecall) {
        return;
      }

      const sessionId = resolveSessionId(ctx);
      const messages = asMessageArray(event.messages);
      const query =
        cachedPromptBySession.get(sessionId)?.trim() ||
        extractQueryFromRecentUserMessages(messages) ||
        event.prompt.trim();
      if (query.length < 3) {
        return;
      }

      // Remove old recalled-context messages before processing
      const filteredMessages = messages.filter((msg) => {
        const text = extractText(msg);
        return !text.includes(RECALLED_CONTEXT_MARKER);
      });
      if (filteredMessages.length !== messages.length) {
        messages.splice(0, messages.length, ...filteredMessages);
      }

      // Smart-trim in plugin mode:
      // We don't have model-resolved reserve tokens in plugin hook context,
      // so we use configured memory budget as a conservative safe limit.
      const trimResult = smartTrim(messages as MessageLike[], query, {
        protectedRecent: 6,
        safeLimit: runtime.config.budget.maxTokens,
        estimateTokens: estimateMessageTokens,
      });

      if (trimResult.didTrim) {
        // Repair tool_use / tool_result pairing after trimming
        const repaired = sanitizeToolUseResultPairing(trimResult.kept as AgentMessage[]);
        messages.splice(0, messages.length, ...repaired);

        // Non-blocking archive of trimmed messages (don't block recall path)
        archiveTrimmedMessagesAsync(trimResult.trimmed, runtime.rawStore, runtime.config.redaction);
        console.info(
          `memory-context: trimmed ${trimResult.trimmed.length} messages (kept ${trimResult.kept.length})`,
        );
      }

      try {
        // Hybrid search with window expansion
        const searchLimit = Math.max(8, Math.ceil(runtime.config.autoRecallMaxTokens / 500));
        const details = await runtime.rawStore.hybridSearch(
          query,
          searchLimit,
          runtime.config.autoRecallMinScore,
          runtime.config.search,
        );

        // ±2 timeline window expansion with decayed scores
        const WINDOW_SIZE = 2;
        const WINDOW_SCORE_DECAY = 0.15;
        const windowedDetails = new Map<string, (typeof details)[number]>();

        for (const result of details) {
          const existing = windowedDetails.get(result.segment.id);
          if (!existing || existing.score < result.score) {
            windowedDetails.set(result.segment.id, result);
          }

          const neighbors = runtime.rawStore.getTimelineNeighbors(result.segment.id, WINDOW_SIZE);
          for (const { segment, distance } of neighbors) {
            if (distance === 0) {
              continue;
            }
            const decayedScore = Math.max(0, result.score * (1 - distance * WINDOW_SCORE_DECAY));
            const prev = windowedDetails.get(segment.id);
            if (!prev || prev.score < decayedScore) {
              windowedDetails.set(segment.id, {
                segment,
                score: decayedScore,
                vectorScore: 0,
                bm25Score: 0,
              });
            }
          }
        }

        const expandedDetails = Array.from(windowedDetails.values());
        console.info(
          `memory-context: window expansion ${details.length} → ${expandedDetails.length} segments`,
        );

        // MMR re-ranking: reduce redundancy while preserving relevance
        const mmrCandidates: MMRCandidate<(typeof expandedDetails)[number]>[] = expandedDetails.map(
          (d) => ({
            item: d,
            score: d.score,
            content: d.segment.content,
          }),
        );
        const mmrLimit = Math.max(searchLimit, expandedDetails.length);
        const diverseDetails = mmrRerank(mmrCandidates, mmrLimit, { lambda: 0.7 });

        const knowledge = runtime.knowledgeStore.search(query);
        const recalled = buildRecalledContextBlock(
          knowledge,
          diverseDetails,
          runtime.config.autoRecallMaxTokens,
        );

        if (!recalled.block) {
          return;
        }

        console.info(
          `memory-context: recalled ${recalled.knowledgeCount} knowledge + ${recalled.detailCount} detail (${recalled.tokens} tokens)`,
        );

        return {
          prependContext: recalled.block,
        };
      } catch (err) {
        console.warn(`memory-context: recall failed (non-fatal): ${String(err)}`);
        return;
      }
    });

    // Archive messages during compaction + optional async knowledge extraction
    api.on("before_compaction", async (event, ctx) => {
      const runtime = await getOrCreateRuntime(api, ctx);
      const messages = asMessageArray(event.messages);
      if (messages.length === 0) {
        return;
      }

      try {
        // Use the bridge function for proper per-message error isolation
        const archived = await archiveCompactedMessages(runtime.rawStore, messages, {
          redaction: runtime.config.redaction,
        });
        if (archived > 0) {
          console.info(`memory-context: archived ${archived} segments from compaction`);
        }
      } catch (err) {
        // Error isolation: archive failure must NOT block compaction
        console.warn(`memory-context: archive failed (non-fatal): ${String(err)}`);
      }

      if (runtime.config.knowledgeExtraction) {
        const llmCall = createKnowledgeExtractionLlmCall(ctx);
        scheduleKnowledgeExtraction(
          messages,
          runtime.knowledgeStore,
          llmCall,
          {
            warn: console.warn.bind(console),
            info: console.info.bind(console),
          },
          runtime.config.redaction,
        );
      }
    });

    // Archive messages before session reset (/new or /reset) to prevent data loss
    api.on("before_reset", async (event, ctx) => {
      try {
        const runtime = await getOrCreateRuntime(api, ctx);
        const messages = asMessageArray(event.messages);
        if (messages.length === 0) {
          return;
        }

        const archived = await archiveCompactedMessages(runtime.rawStore, messages, {
          redaction: runtime.config.redaction,
        });
        if (archived > 0) {
          console.info(`memory-context: archived ${archived} segments before session reset`);
        }
      } catch (err) {
        console.warn(`memory-context: before_reset archive failed (non-fatal): ${String(err)}`);
      }
    });

    api.on("session_end", (_event, ctx) => {
      cachedPromptBySession.delete(ctx.sessionId);
      runtimes.delete(ctx.sessionId);
    });
  },
};

export default memoryContextPlugin;
