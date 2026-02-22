/**
 * Compaction Bridge -- extracts text from AgentMessage-like objects
 * and archives them into the Raw Store during compaction.
 *
 * Called by the Pi extension (memory-context-archive.ts) when
 * session_before_compact fires.
 */

import { extractKnowledge, type LLMCallFn } from "./knowledge-extractor.js";
import type { KnowledgeStore } from "./knowledge-store.js";
import { applyKnowledgeUpdates } from "./knowledge-updater.js";
import { maybeRedact } from "./redaction.js";
import { extractText, stripChannelPrefix, isNoiseSegment } from "./shared.js";
import type { WarmStore, ConversationRole } from "./store.js";

export type AgentMessageLike = {
  role?: string;
  content?: unknown;
};

/**
 * Extract text content from an agent message.
 * Delegates to shared extractText utility.
 */
export function extractMessageText(msg: AgentMessageLike): string {
  return extractText(msg);
}

/**
 * Archive messages to the Raw Store during compaction.
 *
 * - Embedding is skipped (uses addSegmentLite: JSONL + BM25 only, no vector embedding).
 * - Only user/assistant text messages are archived (toolResult skipped by default).
 * - Redaction is applied before storage.
 *
 * Returns the number of segments archived.
 */
export async function archiveCompactedMessages(
  rawStore: WarmStore,
  messages: AgentMessageLike[],
  options: {
    redaction: boolean;
  },
): Promise<number> {
  let archived = 0;

  for (const msg of messages) {
    const role = msg.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }

    let text = extractMessageText(msg);
    if (!text.trim()) {
      continue;
    }

    // Strip channel-injected system prefixes and metadata before storage
    text = stripChannelPrefix(text);
    if (!text.trim()) {
      continue; // After stripping, nothing left (was purely a system message)
    }

    // Skip noise segments that add no recall value
    if (isNoiseSegment(text)) {
      continue;
    }

    // Apply redaction before storage
    text = maybeRedact(text, options.redaction);

    try {
      await rawStore.addSegmentLite({
        role: role as ConversationRole,
        content: text,
      });
      archived++;
    } catch {
      // Best-effort: skip this message, continue with others
      continue;
    }
  }

  return archived;
}

/**
 * Asynchronously extract and apply knowledge from compacted messages.
 * This runs after compaction completes and does NOT block the main flow.
 *
 * @param messages - The messages that were compacted
 * @param knowledgeStore - The knowledge store to update
 * @param llmCall - Function to call the LLM for extraction
 * @param logger - Logger for warnings
 */
export function scheduleKnowledgeExtraction(
  messages: AgentMessageLike[],
  knowledgeStore: KnowledgeStore,
  llmCall: LLMCallFn | undefined,
  logger?: { warn: (msg: string) => void; info: (msg: string) => void },
  redaction = true,
): void {
  if (!llmCall) {
    return;
  }

  // Use queueMicrotask for async execution without blocking
  queueMicrotask(() => {
    void (async () => {
      try {
        const facts = await extractKnowledge(messages, llmCall);
        if (facts.length === 0) {
          return;
        }
        // Redact sensitive content from extracted facts before persisting
        const redactedFacts = facts.map((f) => ({
          ...f,
          content: maybeRedact(f.content, redaction),
          context: f.context ? maybeRedact(f.context, redaction) : f.context,
        }));
        const result = await applyKnowledgeUpdates(knowledgeStore, redactedFacts);
        logger?.info(
          `memory-context: extracted ${facts.length} facts → ` +
            `added=${result.added} updated=${result.updated} ` +
            `superseded=${result.superseded} skipped=${result.skipped}`,
        );
      } catch (err) {
        logger?.warn(`memory-context: async knowledge extraction failed: ${String(err)}`);
      }
    })();
  });
}
