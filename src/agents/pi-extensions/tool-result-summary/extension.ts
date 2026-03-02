/**
 * Tool Result Summary Extension
 *
 * Captures tool execution results, generates summaries via LLM,
 * stores them in a vector database, and retrieves relevant results
 * for future tasks.
 *
 * This extension follows the OpenClaw embedded extension pattern:
 * 1. Runtime state is set via setToolResultSummaryRuntime before session starts
 * 2. Extension reads runtime state to get configuration and services
 * 3. Extension hooks into tool_result and before_agent_start events
 */

import type { TextContent, ImageContent } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../../config/config.js";
import type { EmbeddingProvider } from "../../../memory/embeddings.js";
import { createEmbeddingProvider } from "../../../memory/embeddings.js";
import { createRetriever, buildSearchQuery, formatResultsForContext } from "./retriever.js";
import { getToolResultSummaryRuntime, updateToolResultSummaryRuntime } from "./runtime.js";
import { cacheStore } from "./store-cache.js";
import { ToolResultSummaryStore } from "./store.js";
import { createSummarizer, createLLMClient } from "./summarizer.js";
import { makeToolFilterPredicate, estimateContentLength } from "./tools.js";
import type { ToolResultSummaryConfig, ToolResultSummaryRuntimeValue } from "./types.js";

/**
 * Cached services per runtime.
 */
const serviceCache = new WeakMap<
  object,
  {
    store: ToolResultSummaryStore;
    embeddings: EmbeddingProvider;
    shouldProcess: (toolName: string) => boolean;
    config: ToolResultSummaryConfig;
  }
>();

/**
 * Get or initialize services for the extension.
 */
async function ensureServices(runtime: ToolResultSummaryRuntimeValue): Promise<{
  store: ToolResultSummaryStore;
  embeddings: EmbeddingProvider;
  shouldProcess: (toolName: string) => boolean;
  config: ToolResultSummaryConfig;
} | null> {
  // Check cache first
  const cached = serviceCache.get(runtime);
  if (cached) {
    return cached;
  }

  try {
    const config = runtime.config;

    // Create embeddings provider using memory system
    const openClawConfig = runtime.openClawConfig as OpenClawConfig | undefined;
    const embeddingResult = await createEmbeddingProvider({
      config: openClawConfig ?? {},
      provider: "auto",
      model: "text-embedding-3-small",
      fallback: "none",
    });
    const embeddings = embeddingResult.provider;

    // Check if embeddings provider is available
    if (!embeddings) {
      console.error(
        `tool-result-summary: embedding provider not available (${embeddingResult.providerUnavailableReason ?? "unknown reason"})`,
      );
      return null;
    }

    // Resolve database path
    const resolvedDbPath = runtime.resolvedDbPath ?? config.storage.dbPath;

    // Create store
    const store = new ToolResultSummaryStore(config.storage, embeddings, resolvedDbPath);

    await store.ensureInitialized();

    // Create tool filter
    const shouldProcess = makeToolFilterPredicate(config.tools);

    // Cache the result
    const result = { store, embeddings, shouldProcess, config };
    serviceCache.set(runtime, result);

    // Also cache by dbPath for cross-context access
    cacheStore(resolvedDbPath, store);

    return result;
  } catch (err) {
    console.error(`tool-result-summary: service initialization failed: ${String(err)}`);
    return null;
  }
}

/**
 * Main extension entry point.
 *
 * This extension is loaded by Pi when its path is returned from
 * buildEmbeddedExtensionPaths. It reads configuration from the
 * runtime registry set by setToolResultSummaryRuntime.
 */
export default function toolResultSummaryExtension(api: ExtensionAPI): void {
  api.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
    return handleToolResult(event, ctx);
  });

  // Mark compaction occurred when session is about to compact
  api.on("session_before_compact", async (_event, ctx: ExtensionContext) => {
    updateToolResultSummaryRuntime(ctx.sessionManager, {
      compactionOccurred: true,
    });
  });

  api.on("context", async (event, ctx) => {
    // Check if we should inject context
    const runtime = getRuntime(ctx.sessionManager);
    if (!runtime || !runtime.config.enabled) {
      return undefined;
    }

    const config = runtime.config;
    if (config.mode === "off" || config.mode === "store-only") {
      return undefined;
    }

    // Only retrieve after compaction has occurred (avoid redundancy with existing context)
    if (!runtime.compactionOccurred) {
      return undefined;
    }

    // Get the last user message as the query context
    const messages = event.messages;
    const lastUserMessage = [...messages].toReversed().find((m) => m.role === "user");
    if (!lastUserMessage) {
      return undefined;
    }

    const prompt = getUserMessageText(lastUserMessage);
    if (!prompt || prompt.trim().length < 10) {
      return undefined;
    }

    const services = await ensureServices(runtime);
    if (!services) {
      return undefined;
    }

    try {
      const sessionId = getSessionId(ctx);
      const retriever = createRetriever(config.retrieval, services.store, services.embeddings);

      const query = buildSearchQuery({ prompt });
      const result = await retriever.retrieveAndFormat(query, { sessionId });

      if (result.count === 0) {
        return undefined;
      }

      // Deduplication: filter out results already in current context
      const existingToolCallIds = collectExistingToolCallIds(messages);
      const filteredResults = result.results.filter(
        (r) => !existingToolCallIds.has(r.entry.toolCallId),
      );

      if (filteredResults.length === 0) {
        return undefined;
      }

      // Update access counts for filtered results
      for (const r of filteredResults) {
        await services.store.touch(r.entry.id);
      }

      // Re-format filtered results
      const filteredContextBlock = formatResultsForContext(
        filteredResults,
        config.retrieval.injectFullContent,
        config.retrieval.maxFullContentChars,
      );

      // Inject context by appending to the last user message
      const contextNote = `\n\n${filteredContextBlock}`;
      const modifiedMessages = messages.map((m) => {
        if (m.role === "user" && m === lastUserMessage) {
          if (typeof m.content === "string") {
            return { ...m, content: m.content + contextNote };
          } else if (Array.isArray(m.content)) {
            const newContent = m.content.map((block) => {
              if (block.type === "text") {
                return { ...block, text: block.text + contextNote };
              }
              return block;
            });
            return { ...m, content: newContent };
          }
        }
        return m;
      });

      return { messages: modifiedMessages };
    } catch (err) {
      console.warn(`tool-result-summary: retrieval failed: ${String(err)}`);
      return undefined;
    }
  });
}

/**
 * Collect existing tool call IDs from messages in current context.
 */
function collectExistingToolCallIds(messages: unknown[]): Set<string> {
  const ids = new Set<string>();

  for (const msg of messages) {
    const m = msg as { role?: string; toolCallId?: string };
    if (m.role === "toolResult" && m.toolCallId) {
      ids.add(m.toolCallId);
    }
  }

  return ids;
}

/**
 * Extract text from a user message.
 */
function getUserMessageText(message: { role: string; content: unknown }): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

/**
 * Get runtime value from session manager.
 */
function getRuntime(sessionManager: unknown): ToolResultSummaryRuntimeValue | null {
  const runtime = getToolResultSummaryRuntime(sessionManager);
  if (!runtime || !("config" in runtime)) {
    return null;
  }
  return runtime as ToolResultSummaryRuntimeValue;
}

/**
 * Handle tool_result event - store the result with summary.
 */
async function handleToolResult(
  event: ToolResultEvent,
  ctx: ExtensionContext,
): Promise<{ content?: (TextContent | ImageContent)[] } | undefined> {
  const runtime = getRuntime(ctx.sessionManager);
  if (!runtime || !runtime.config.enabled) {
    return undefined;
  }

  const config = runtime.config;
  if (config.mode === "off" || config.mode === "retrieve-only") {
    return undefined;
  }

  const services = await ensureServices(runtime);
  if (!services) {
    return undefined;
  }

  // Check if this tool should be processed
  if (!services.shouldProcess(event.toolName)) {
    return undefined;
  }

  // Check content length
  const contentLength = estimateContentLength(
    event.content as Array<{ type: string; text?: string }>,
  );
  if (contentLength < config.tools.minContentChars) {
    return undefined;
  }

  // Skip error results
  if (event.isError) {
    return undefined;
  }

  try {
    const sessionId = getSessionId(ctx);
    const model = ctx.model;

    // Create summarizer
    const llmClient = createLLMClient({
      model,
      sessionId,
    });
    const summarizer = createSummarizer(config.summary, llmClient);

    // Generate summary
    const summaryResult = await summarizer.summarize({
      toolName: event.toolName,
      input: event.input,
      content: event.content,
      isError: event.isError,
    });

    if (!summaryResult.ok) {
      console.warn(`tool-result-summary: summarization failed: ${summaryResult.error}`);
      return undefined;
    }

    // Store the result
    await services.store.store({
      sessionId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      summary: summaryResult.summary,
      originalContent: event.content,
      isError: event.isError,
      details: event.details,
    });

    // Update runtime state
    updateToolResultSummaryRuntime(ctx.sessionManager, {
      entryCount: services.store.getCount(),
    });

    return undefined;
  } catch (err) {
    console.warn(`tool-result-summary: failed to store result: ${String(err)}`);
    return undefined;
  }
}

/**
 * Get session ID from context.
 */
function getSessionId(ctx: ExtensionContext): string {
  const sm = ctx.sessionManager as unknown as {
    sessionId?: string;
    sessionFile?: string;
  };

  if (sm.sessionId) {
    return sm.sessionId;
  }

  if (sm.sessionFile) {
    const parts = sm.sessionFile.split(/[/\\]/);
    const fileName = parts[parts.length - 1];
    return fileName.replace(/\.json$/, "");
  }

  return "default";
}
