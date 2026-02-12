/**
 * Pi Extension: memory-context-archive
 *
 * Listens to session_before_compact and archives messagesToSummarize
 * into the Raw Store. Optionally triggers async knowledge extraction.
 *
 * IMPORTANT: This handler returns undefined (does not return a compaction result),
 * so it does NOT interfere with compaction-safeguard's summarization.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { completeSimple } from "@mariozechner/pi-ai";
import {
  archiveCompactedMessages,
  scheduleKnowledgeExtraction,
} from "../memory-context/compaction-bridge.js";
import { getMemoryContextRuntime } from "../memory-context/runtime.js";

export default function memoryContextArchiveExtension(api: ExtensionAPI): void {
  api.on("session_before_compact", async (event, ctx) => {
    const runtime = getMemoryContextRuntime(ctx.sessionManager);
    if (!runtime) {
      return undefined; // Memory context not enabled for this session
    }

    const { preparation } = event;
    const messages = preparation.messagesToSummarize ?? [];

    if (messages.length === 0) {
      return undefined;
    }

    try {
      // Archive to Raw Store (synchronous-ish: only JSONL append + BM25, no embedding)
      const archived = await archiveCompactedMessages(runtime.rawStore, messages, {
        redaction: runtime.config.redaction,
      });

      if (archived > 0) {
        console.info(`memory-context: archived ${archived} segments from compaction`);
      }

      // Async knowledge extraction (non-blocking)
      if (runtime.config.knowledgeExtraction) {
        // Create llmCall from Pi context if model/apiKey available
        // Build llmCall from Pi context (model + apiKey).
        // Uses the provider's chat completion call (not generateSummary).
        let llmCall: ((prompt: string) => Promise<string>) | undefined;
        const model = ctx.model;
        if (model) {
          const apiKey = await ctx.modelRegistry.getApiKey(model);
          if (apiKey) {
            llmCall = async (prompt: string) => {
              try {
                const res = await completeSimple(
                  model,
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
                  .filter((b) => b.type === "text")
                  .map((b) => b.text)
                  .join("\n");
              } catch {
                return "";
              }
            };
          }
        }

        scheduleKnowledgeExtraction(messages, runtime.knowledgeStore, llmCall, {
          warn: console.warn.bind(console),
          info: console.info.bind(console),
        });
      }
    } catch (err) {
      // Error isolation: archive failure must NOT block compaction
      console.warn(`memory-context: archive failed (non-fatal): ${String(err)}`);
    }

    // Return undefined: do NOT produce a compaction result.
    // compaction-safeguard handles the actual summarization.
    return undefined;
  });
}
