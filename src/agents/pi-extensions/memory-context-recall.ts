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
import { smartTrim, type MessageLike } from "../memory-context/smart-trim.js";
import { getCompactionSafeguardRuntime } from "./compaction-safeguard-runtime.js";

/** Marker to identify injected recalled-context messages. */
const RECALLED_CONTEXT_MARKER = '<recalled-context source="memory-context">';

function isRecalledContextMessage(msg: AgentMessage): boolean {
  const content = typeof msg.content === "string" ? msg.content : "";
  return content.includes(RECALLED_CONTEXT_MARKER);
}

function extractText(msg: AgentMessage): string {
  if (typeof msg.content === "string") {
    return msg.content;
  }
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<{ type?: string; text?: string }>)
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join(" ");
  }
  return "";
}

/**
 * Extract search query from last 2-3 user messages (broader keyword coverage).
 */
function extractSearchQuery(messages: AgentMessage[]): string {
  const userMessages: string[] = [];
  for (let i = messages.length - 1; i >= 0 && userMessages.length < 3; i--) {
    const msg = messages[i];
    if (msg && (msg as { role?: string }).role === "user") {
      const content = extractText(msg);
      if (content.trim() && !content.includes(RECALLED_CONTEXT_MARKER)) {
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

export default function memoryContextRecallExtension(api: ExtensionAPI): void {
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
    const query = extractSearchQuery(messages);

    // ========== Step 3: Smart Trim (if near overflow) ==========
    const hardCap = computeHardCap(runtime);
    // Read reserveTokens from compaction-safeguard-runtime (dynamic, not hardcoded)
    const safeguardRuntime = getCompactionSafeguardRuntime(ctx.sessionManager);
    const reserveTokens =
      typeof safeguardRuntime?.reserveTokens === "number" ? safeguardRuntime.reserveTokens : 4000;
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
      messages = trimResult.kept as AgentMessage[];

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
                const archivedText = maybeRedact(text, runtime.config.redaction);
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

      const recall = buildRecalledContextBlock(knowledgeFacts, rawResults, hardCap);

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

      return { messages: result };
    } catch (err) {
      console.warn(`memory-context: recall failed (non-fatal): ${String(err)}`);
      return messages !== event.messages ? { messages } : undefined;
    }
  });
}
