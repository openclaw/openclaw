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
import { getGlobalMemoryRuntime } from "../memory-context/global-runtime.js";

export default function memoryContextArchiveExtension(api: ExtensionAPI): void {
  api.on("session_before_compact", async (event, ctx) => {
    const sessionId =
      (ctx.sessionManager as unknown as { sessionId?: string }).sessionId ?? "unknown";
    const runtime = getGlobalMemoryRuntime(sessionId);
    if (!runtime) {
      return undefined;
    }

    const { preparation, branchEntries } = event;
    // Use branchEntries.message payloads when messagesToSummarize is empty.
    // Pi may expose compacted content as branch entries rather than plain messages.
    const fallbackMessages = Array.isArray(branchEntries)
      ? branchEntries
          .map((entry) =>
            entry && typeof entry === "object"
              ? (entry as { message?: { role?: string; content?: unknown } }).message
              : undefined,
          )
          .filter(
            (m): m is { role?: string; content?: unknown } =>
              !!m && (m.role === "user" || m.role === "assistant"),
          )
      : [];
    const messages = (
      preparation.messagesToSummarize?.length > 0
        ? preparation.messagesToSummarize
        : fallbackMessages
    ) as Array<{ role?: string; content?: unknown }>;

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
        // Prefer subagent model for extraction (faster, cheaper) with fallback to main model.
        let llmCall: ((prompt: string) => Promise<string>) | undefined;

        // Try subagent model first
        let resolvedModel = ctx.model;
        let resolvedApiKey: string | undefined;
        if (runtime.extractionModel) {
          const { provider, modelId } = runtime.extractionModel;
          const allModels = ctx.modelRegistry.getAll() as Array<{ id?: string; provider?: string }>;
          const match = allModels.find((m) => m.id === modelId && m.provider === provider) as
            | typeof resolvedModel
            | undefined;
          if (match) {
            const key = await ctx.modelRegistry.getApiKey(match);
            if (key) {
              resolvedModel = match;
              resolvedApiKey = key;
            }
          }
        }
        // Fallback to main model
        if (!resolvedApiKey && resolvedModel) {
          resolvedApiKey = await ctx.modelRegistry.getApiKey(resolvedModel);
        }

        if (resolvedModel && resolvedApiKey) {
          const model = resolvedModel;
          const apiKey = resolvedApiKey;
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

        scheduleKnowledgeExtraction(messages, runtime.knowledgeStore, llmCall, {
          warn: console.warn.bind(console),
          info: console.info.bind(console),
        }, runtime.config.redaction);
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
