import type { AgentMessage } from "@mariozechner/pi-agent-core";
/**
 * Pi Extension: memory-context-recall (Phase 6 upgraded)
 *
 * Listens to the "context" event and performs three operations:
 * 1. Smart trim: if context is near overflow, trim low-relevance messages
 * 2. Archive: non-blocking archive of trimmed messages to Raw Store
 * 3. Recall inject: search memory and inject recalled-context block
 *
 * Execution order in context chain: runs AFTER context-pruning (micro-level).
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getGlobalMemoryRuntime, computeHardCap } from "../memory-context/global-runtime.js";
import { buildRecalledContextBlock } from "../memory-context/recall-format.js";
import { maybeRedact } from "../memory-context/redaction.js";
import { stripChannelPrefix } from "../memory-context/shared.js";
import { smartTrim, type MessageLike } from "../memory-context/smart-trim.js";
import { sanitizeToolUseResultPairing } from "../session-transcript-repair.js";
import { getCompactionSafeguardRuntime } from "./compaction-safeguard-runtime.js";

/** Marker to identify injected recalled-context messages. */
const RECALLED_CONTEXT_MARKER = '<recalled-context source="memory-context">';

function getMessageContent(msg: AgentMessage): string | unknown[] | undefined {
  return (msg as { content?: string | unknown[] }).content;
}

function isRecalledContextMessage(msg: AgentMessage): boolean {
  const raw = getMessageContent(msg);
  const content = typeof raw === "string" ? raw : "";
  return content.includes(RECALLED_CONTEXT_MARKER);
}

function extractText(msg: AgentMessage): string {
  const raw = getMessageContent(msg);
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return (raw as Array<{ type?: string; text?: string }>)
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join(" ");
  }
  return "";
}

/**
 * Check if a message is a channel-injected system prefix (e.g. Feishu metadata).
 * These contain no user intent and should be excluded from search queries.
 * Matches both "System: [2026-02-15 ..." and "[Sun 2026-02-15 ..." formats.
 * Imported from shared.ts as the canonical source.
 */
// Re-export for local use; canonical definition is in shared.ts
const SYSTEM_PREFIX_RE = /^(?:System:\s*)?\[(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+\d{4}-\d{2}-\d{2}\s/;

/**
 * Extract search query from last 2-3 user messages (broader keyword coverage).
 * Skips channel system-prefix messages and recalled-context blocks.
 */
function extractSearchQuery(messages: AgentMessage[]): string {
  const userMessages: string[] = [];
  for (let i = messages.length - 1; i >= 0 && userMessages.length < 3; i--) {
    const msg = messages[i];
    if (msg && (msg as { role?: string }).role === "user") {
      const content = extractText(msg);
      if (
        content.trim() &&
        !content.includes(RECALLED_CONTEXT_MARKER) &&
        !SYSTEM_PREFIX_RE.test(content.trim())
      ) {
        userMessages.unshift(content);
      }
    }
  }
  return userMessages.join(" ").trim();
}

/**
 * Simple token estimator for smart-trim (uses char/3 heuristic).
 * Phase 6 缺口1 notes: ideally use Pi's estimateTokens, but that requires
 * importing from @mariozechner/pi-coding-agent which may not be available
 * in all contexts. This is a safe fallback.
 */
function estimateMessageTokens(msg: MessageLike): number {
  const text = extractText(msg as AgentMessage);
  return Math.max(1, Math.ceil(text.length / 3));
}

/**
 * Cached user prompt from the before_agent_start event.
 * This captures the user input BEFORE channel-injected system messages
 * are mixed into the messages array.
 *
 * Note: In gateway mode, event.prompt may still contain system event lines
 * prepended by prependSystemEvents (e.g. "System: [timestamp] Feishu[main] ...").
 * We strip those before caching.
 */
let cachedUserPrompt: string | undefined;

// stripSystemPrefix delegates to the shared stripChannelPrefix
const stripSystemPrefix = stripChannelPrefix;

export default function memoryContextRecallExtension(api: ExtensionAPI): void {
  // Cache the clean user prompt before the agent loop starts.
  // This fires once per user interaction, before any context events.
  api.on("before_agent_start", (event) => {
    cachedUserPrompt = stripSystemPrefix(event.prompt);
  });

  api.on("context", async (event: { messages: AgentMessage[] }, ctx: ExtensionContext) => {
    const sessionId =
      (ctx.sessionManager as unknown as { sessionId?: string }).sessionId ?? "unknown";
    const runtime = getGlobalMemoryRuntime(sessionId);
    if (!runtime) {
      return undefined;
    }

    let messages = event.messages;

    // ========== Step 1: Remove old recalled-context messages ==========
    messages = messages.filter((msg) => !isRecalledContextMessage(msg));

    // ========== Step 2: Extract search query ==========
    // Prefer cachedUserPrompt (clean, from before_agent_start) over
    // extractSearchQuery (messages array may contain channel system messages).
    const query = cachedUserPrompt?.trim() || extractSearchQuery(messages);
    if (cachedUserPrompt) {
      console.info(
        `memory-context: using cachedUserPrompt for query: "${cachedUserPrompt.substring(0, 80)}"`,
      );
    }

    // ========== Step 3: Smart Trim (if near overflow) ==========
    const hardCap = computeHardCap(runtime);
    // Derive reserveTokens from compaction-safeguard-runtime (dynamic, not hardcoded).
    // CompactionSafeguardRuntimeValue exposes maxHistoryShare + contextWindowTokens;
    // reserveTokens = contextWindowTokens * (1 - maxHistoryShare).
    const safeguardRuntime = getCompactionSafeguardRuntime(ctx.sessionManager);
    const reserveTokens =
      safeguardRuntime?.contextWindowTokens && safeguardRuntime?.maxHistoryShare
        ? Math.round(safeguardRuntime.contextWindowTokens * (1 - safeguardRuntime.maxHistoryShare))
        : 4000;
    const safeLimit = runtime.contextWindowTokens - reserveTokens - hardCap;

    // Only do smart trim if we have a meaningful query.
    // If query is too short (e.g. "y", "ok"), skip trimming to avoid
    // destructive trimming without recall compensation.
    const hasUsableQuery = query.length >= 3;

    const trimResult = hasUsableQuery
      ? smartTrim(messages as MessageLike[], query, {
          protectedRecent: 6,
          safeLimit,
          estimateTokens: estimateMessageTokens,
        })
      : { kept: messages, trimmed: [] as MessageLike[], didTrim: false };

    if (trimResult.didTrim) {
      // Repair tool_use / tool_result pairing after trimming to prevent
      // "unexpected tool_use_id" errors from the LLM API.
      messages = sanitizeToolUseResultPairing(trimResult.kept as AgentMessage[]);

      // Non-blocking archive of trimmed messages
      if (trimResult.trimmed.length > 0) {
        queueMicrotask(() => {
          void (async () => {
            try {
              for (const msg of trimResult.trimmed) {
                const role = msg.role;
                if (role !== "user" && role !== "assistant") {
                  continue;
                }
                const text = extractText(msg as AgentMessage);
                if (!text.trim()) {
                  continue;
                }
                // Skip recalled-context blocks (should not be archived)
                if (text.includes(RECALLED_CONTEXT_MARKER)) {
                  continue;
                }
                // Strip channel system prefixes before archiving
                const cleanedText = stripChannelPrefix(text);
                if (!cleanedText) {
                  continue;
                }
                const archivedText = maybeRedact(cleanedText, runtime.config.redaction);
                // Check if already archived (dedup)
                if (runtime.rawStore.isArchived(role as "user" | "assistant", archivedText)) {
                  continue;
                }
                await runtime.rawStore.addSegmentLite({
                  role: role as "user" | "assistant",
                  content: archivedText,
                });
              }
            } catch (err) {
              console.warn(
                `memory-context: async archive of trimmed messages failed: ${String(err)}`,
              );
            }
          })();
        });

        console.info(
          `memory-context: trimmed ${trimResult.trimmed.length} messages (kept ${trimResult.kept.length})`,
        );
      }
    }

    // ========== Step 4: Recall injection ==========
    if (!hasUsableQuery) {
      return messages !== event.messages ? { messages } : undefined;
    }

    try {
      await runtime.rawStore.init();
      await runtime.knowledgeStore.init();
      const ksStats = runtime.knowledgeStore.stats();
      if (ksStats.active === 0 && ksStats.total === 0) {
        console.warn(
          `memory-context: KnowledgeStore empty after init (filePath may be wrong or file empty)`,
        );
      }

      const searchConfig = {
        vectorWeight: 0.7,
        bm25Weight: 0.3,
        timeDecay: 0.995,
      };

      // Dynamic search limit based on hardcap budget
      const searchLimit = Math.max(8, Math.ceil(hardCap / 500));
      const rawResults = await runtime.rawStore.hybridSearch(
        query,
        searchLimit,
        runtime.config.autoRecallMinScore,
        searchConfig,
      );

      const knowledgeFacts = runtime.knowledgeStore.search(query, 10);

      if (knowledgeFacts.length === 0) {
        const stats = runtime.knowledgeStore.stats();
        console.info(
          `memory-context: knowledge search returned 0 for query="${query.substring(0, 60)}" (store: active=${stats.active}, total=${stats.total})`,
        );
      }

      // ---- Window expansion: enrich search results with neighboring segments ----
      const WINDOW_SIZE = 2; // ±2 segments around each match
      const WINDOW_SCORE_DECAY = 0.15; // score drops 15% per step from matched segment

      const windowedSegments = new Map<
        string,
        { segment: import("../memory-context/store.js").ConversationSegment; score: number }
      >();

      for (const result of rawResults) {
        // Keep the original matched segment with its search score
        const existing = windowedSegments.get(result.segment.id);
        if (!existing || existing.score < result.score) {
          windowedSegments.set(result.segment.id, {
            segment: result.segment,
            score: result.score,
          });
        }

        // Expand window: add neighboring segments with decayed scores
        const neighbors = runtime.rawStore.getTimelineNeighbors(result.segment.id, WINDOW_SIZE);
        for (const { segment: neighbor, distance } of neighbors) {
          if (distance === 0) {
            continue;
          } // skip self (already added above)
          const decayedScore = Math.max(0, result.score * (1 - distance * WINDOW_SCORE_DECAY));
          const prev = windowedSegments.get(neighbor.id);
          if (!prev || prev.score < decayedScore) {
            windowedSegments.set(neighbor.id, { segment: neighbor, score: decayedScore });
          }
        }
      }

      const expandedResults = Array.from(windowedSegments.values());

      console.info(
        `memory-context: window expansion ${rawResults.length} → ${expandedResults.length} segments`,
      );

      const recall = buildRecalledContextBlock(knowledgeFacts, expandedResults, hardCap);

      if (!recall.block) {
        return messages !== event.messages ? { messages } : undefined;
      }

      // ========== Step 5: Inject recalled-context ==========
      const recalledMessage: AgentMessage = {
        role: "user",
        content: recall.block,
      } as AgentMessage;

      // Insert AFTER system prompt and compaction summary, BEFORE recent messages.
      // Find the first user/assistant message and insert after it (not before).
      let insertIdx = 1; // Default: after first message
      for (let i = 0; i < messages.length; i++) {
        const role = (messages[i] as { role?: string }).role;
        if (role === "user" || role === "assistant") {
          insertIdx = i + 1; // Insert AFTER this message (the summary/first turn)
          break;
        }
      }
      // Clamp to valid range
      if (insertIdx > messages.length) {
        insertIdx = messages.length;
      }

      const result = [...messages];
      result.splice(insertIdx, 0, recalledMessage);

      // ========== Step 6: Final hardcap check ==========
      // Ensure injection didn't push us back over safeLimit
      let totalAfter = 0;
      for (const msg of result) {
        totalAfter += estimateMessageTokens(msg as MessageLike);
      }
      if (totalAfter > safeLimit + hardCap) {
        // Over budget even with injection - skip injection, just return trimmed
        console.warn(
          `memory-context: injection would exceed safe limit (${totalAfter} > ${safeLimit + hardCap}), skipping recall`,
        );
        return messages !== event.messages ? { messages } : undefined;
      }

      console.info(
        `memory-context: recalled ${recall.knowledgeCount} knowledge + ${recall.detailCount} detail (${recall.tokens} tokens, hardCap ${hardCap})`,
      );

      // Final defensive repair: ensure no orphaned tool_results after injection
      return { messages: sanitizeToolUseResultPairing(result) };
    } catch (err) {
      console.warn(`memory-context: recall failed (non-fatal): ${String(err)}`);
      return messages !== event.messages ? { messages } : undefined;
    }
  });
}
