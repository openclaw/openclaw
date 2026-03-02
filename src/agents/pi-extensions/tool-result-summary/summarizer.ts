/**
 * LLM-based summarizer for tool execution results.
 *
 * Generates concise summaries of tool outputs for vector indexing.
 * Supports caching and batch processing to reduce LLM API calls.
 */

import { createHash } from "crypto";
import type { TextContent, ImageContent } from "@mariozechner/pi-ai";
import type { SummaryConfig, SummaryCacheConfig } from "./types.js";

/**
 * Result of summarization.
 */
export type SummarizationResult =
  | { ok: true; summary: string; truncated: boolean; cached?: boolean }
  | { ok: false; error: string };

/**
 * LLM client interface for summary generation.
 */
export interface LLMClient {
  generate(
    prompt: string,
    options?: { maxTokens?: number; maxChars?: number; timeoutMs?: number },
  ): Promise<string>;

  generateBatch?(
    prompts: string[],
    options?: { maxTokens?: number; maxChars?: number; timeoutMs?: number },
  ): Promise<string[]>;
}

/**
 * Cache entry for summary caching.
 */
interface CacheEntry {
  summary: string;
  createdAt: number;
  contentHash: string;
}

/**
 * Pending item for batch processing.
 */
interface PendingItem {
  params: {
    toolName: string;
    input: Record<string, unknown>;
    content: (TextContent | ImageContent)[];
    isError: boolean;
  };
  contentText: string;
  contentHash: string;
  resolve: (result: SummarizationResult) => void;
  reject: (error: Error) => void;
}

/**
 * Global summary cache (shared across all summarizer instances).
 */
const summaryCache = new Map<string, CacheEntry>();

/**
 * Global batch processor state.
 */
let pendingItems: PendingItem[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Generate a hash key for caching based on tool name and input.
 */
function generateCacheKey(
  toolName: string,
  input: Record<string, unknown>,
  contentHash: string,
): string {
  const inputJson = safeStringify(input, 500);
  const hashInput = `${toolName}:${inputJson}:${contentHash}`;
  return createHash("md5").update(hashInput).digest("hex").slice(0, 32);
}

/**
 * Generate a hash of content for cache invalidation.
 */
function hashContent(contentText: string): string {
  return createHash("md5").update(contentText).digest("hex").slice(0, 16);
}

/**
 * Check cache for existing summary.
 */
function checkCache(
  key: string,
  config: SummaryCacheConfig,
): { summary: string; expired: boolean } | null {
  if (!config.enabled) {
    return null;
  }

  const entry = summaryCache.get(key);
  if (!entry) {
    return null;
  }

  // Check TTL
  if (config.ttlMs > 0 && Date.now() - entry.createdAt > config.ttlMs) {
    summaryCache.delete(key);
    return { summary: entry.summary, expired: true };
  }

  return { summary: entry.summary, expired: false };
}

/**
 * Store summary in cache.
 */
function storeInCache(
  key: string,
  contentHash: string,
  summary: string,
  config: SummaryCacheConfig,
): void {
  if (!config.enabled) {
    return;
  }

  // Evict oldest entries if cache is full
  if (summaryCache.size >= config.maxEntries) {
    const oldestKey = summaryCache.keys().next().value;
    if (oldestKey) {
      summaryCache.delete(oldestKey);
    }
  }

  summaryCache.set(key, {
    summary,
    contentHash,
    createdAt: Date.now(),
  });
}

/**
 * Process a batch of pending items.
 */
async function processBatch(config: SummaryConfig, llmClient: LLMClient): Promise<void> {
  const items = pendingItems;
  pendingItems = [];

  if (items.length === 0) {
    return;
  }

  // Check cache for each item first
  const uncachedItems: PendingItem[] = [];
  for (const item of items) {
    const cacheKey = generateCacheKey(item.params.toolName, item.params.input, item.contentHash);
    const cached = checkCache(cacheKey, config.cache!);

    if (cached && !cached.expired) {
      item.resolve({ ok: true, summary: cached.summary, truncated: true, cached: true });
    } else {
      uncachedItems.push(item);
    }
  }

  if (uncachedItems.length === 0) {
    return;
  }

  // Build prompts for uncached items
  const prompts = uncachedItems.map((item) =>
    buildSummaryPrompt(item.params, item.contentText, config.maxChars),
  );

  try {
    // Try batch generation if supported
    let summaries: string[];
    if (llmClient.generateBatch && uncachedItems.length > 1) {
      summaries = await llmClient.generateBatch(prompts, {
        maxTokens: config.maxChars * 2,
        maxChars: config.maxChars,
        timeoutMs: config.timeoutMs,
      });
    } else {
      // Fall back to individual generation
      summaries = await Promise.all(
        prompts.map((prompt) =>
          llmClient.generate(prompt, {
            maxTokens: config.maxChars * 2,
            maxChars: config.maxChars,
            timeoutMs: config.timeoutMs,
          }),
        ),
      );
    }

    // Process results
    for (let i = 0; i < uncachedItems.length; i++) {
      const item = uncachedItems[i];
      const summary = summaries[i]?.trim() || "";

      if (!summary) {
        // Fallback to truncation
        item.resolve({
          ok: true,
          summary: item.contentText.slice(0, config.maxChars) + "...",
          truncated: true,
        });
      } else {
        const finalSummary = summary.slice(0, config.maxChars);

        // Cache the result
        const cacheKey = generateCacheKey(
          item.params.toolName,
          item.params.input,
          item.contentHash,
        );
        storeInCache(cacheKey, item.contentHash, finalSummary, config.cache!);

        item.resolve({
          ok: true,
          summary: finalSummary,
          truncated: true,
          cached: false,
        });
      }
    }
  } catch {
    // On error, fall back to truncation for all items
    for (const item of uncachedItems) {
      item.resolve({
        ok: true,
        summary: item.contentText.slice(0, config.maxChars) + "...",
        truncated: true,
      });
    }
  }
}

/**
 * Flush the current batch.
 */
async function flushBatch(config: SummaryConfig, llmClient: LLMClient): Promise<void> {
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  await processBatch(config, llmClient);
}

/**
 * Schedule batch processing.
 */
function scheduleBatch(config: SummaryConfig, llmClient: LLMClient): void {
  const batchConfig = config.batch!;

  if (pendingItems.length >= batchConfig.maxSize) {
    // Process immediately if max size reached
    void processBatch(config, llmClient);
    return;
  }

  if (!batchTimer) {
    batchTimer = setTimeout(() => {
      void processBatch(config, llmClient);
    }, batchConfig.maxDelayMs);
  }
}

/**
 * Create a summarizer instance with caching and batch processing.
 */
export function createSummarizer(config: SummaryConfig, llmClient: LLMClient) {
  return {
    /**
     * Generate a summary for a tool execution result.
     * Uses caching for similar inputs and batch processing to reduce API calls.
     */
    async summarize(params: {
      toolName: string;
      input: Record<string, unknown>;
      content: (TextContent | ImageContent)[];
      isError: boolean;
    }): Promise<SummarizationResult> {
      const contentText = extractTextContent(params.content);
      const contentLength = contentText.length;
      const contentHash = hashContent(contentText);

      // If content is short enough, use it directly (no caching needed)
      if (contentLength <= config.maxChars) {
        return { ok: true, summary: contentText, truncated: false };
      }

      // If content is below threshold, just truncate (no caching needed)
      if (contentLength <= config.minContentForSummarization) {
        return {
          ok: true,
          summary: contentText.slice(0, config.maxChars) + "...",
          truncated: true,
        };
      }

      // Check cache
      const cacheKey = generateCacheKey(params.toolName, params.input, contentHash);
      const cached = checkCache(cacheKey, config.cache!);
      if (cached && !cached.expired) {
        return { ok: true, summary: cached.summary, truncated: true, cached: true };
      }

      // Use batch processing if enabled
      if (config.batch?.enabled) {
        return new Promise<SummarizationResult>((resolve, reject) => {
          pendingItems.push({
            params,
            contentText,
            contentHash,
            resolve,
            reject,
          });
          scheduleBatch(config, llmClient);
        });
      }

      // Direct LLM call (no batching)
      try {
        const prompt = buildSummaryPrompt(params, contentText, config.maxChars);
        const summary = await llmClient.generate(prompt, {
          maxTokens: config.maxChars * 2, // Allow some buffer
          maxChars: config.maxChars,
          timeoutMs: config.timeoutMs,
        });

        if (!summary || summary.trim().length === 0) {
          // Fallback to truncation if LLM returns empty
          return {
            ok: true,
            summary: contentText.slice(0, config.maxChars) + "...",
            truncated: true,
          };
        }

        const finalSummary = summary.trim().slice(0, config.maxChars);

        // Cache the result
        storeInCache(cacheKey, contentHash, finalSummary, config.cache!);

        return {
          ok: true,
          summary: finalSummary,
          truncated: true,
          cached: false,
        };
      } catch {
        // On error, fall back to truncation
        return {
          ok: true,
          summary: contentText.slice(0, config.maxChars) + "...",
          truncated: true,
        };
      }
    },

    /**
     * Flush any pending batch items immediately.
     */
    async flush(): Promise<void> {
      await flushBatch(config, llmClient);
    },

    /**
     * Get cache statistics.
     */
    getCacheStats(): { size: number; maxEntries: number } {
      return {
        size: summaryCache.size,
        maxEntries: config.cache?.maxEntries || 0,
      };
    },

    /**
     * Clear the summary cache.
     */
    clearCache(): void {
      summaryCache.clear();
    },
  };
}

/**
 * Build the prompt for summary generation.
 */
function buildSummaryPrompt(
  params: {
    toolName: string;
    input: Record<string, unknown>;
    isError: boolean;
  },
  contentText: string,
  maxChars: number,
): string {
  const inputJson = safeStringify(params.input, 500);

  return `Summarize the following tool execution result in 1-2 concise sentences.

## Tool Information
- Name: ${params.toolName}
- Input: ${inputJson}
- Status: ${params.isError ? "ERROR" : "SUCCESS"}

## Result (first 2000 chars)
\`\`\`
${contentText.slice(0, 2000)}
\`\`\`

## Instructions
Provide a brief summary (max ${maxChars} characters) that captures:
1. What the tool did
2. Key findings, outcomes, or errors

Write the summary directly, without any preamble or explanation.

Summary:`;
}

/**
 * Extract text content from content blocks.
 */
export function extractTextContent(content: (TextContent | ImageContent)[]): string {
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Safely stringify JSON with length limit.
 */
function safeStringify(obj: unknown, maxLength: number): string {
  try {
    const str = JSON.stringify(obj, null, 2);
    if (str.length <= maxLength) {
      return str;
    }
    return str.slice(0, maxLength) + "...";
  } catch {
    return "[unable to stringify]";
  }
}

/**
 * Create an LLM client using the existing model infrastructure.
 */
export function createLLMClient(_params: { model: unknown; sessionId: string }): LLMClient {
  return {
    async generate(
      prompt: string,
      options?: { maxTokens?: number; maxChars?: number; timeoutMs?: number },
    ): Promise<string> {
      // This is a simplified implementation
      // In practice, this would use the session's model to generate the summary
      // The actual implementation depends on the available model API

      // For now, we'll use a simple heuristic-based summarization
      // as fallback when LLM is not available
      return heuristicSummary(prompt, options?.maxChars || 200);
    },

    async generateBatch(
      prompts: string[],
      options?: { maxTokens?: number; maxChars?: number; timeoutMs?: number },
    ): Promise<string[]> {
      // Batch implementation - process all prompts
      const maxChars = options?.maxChars || 200;
      return Promise.all(prompts.map((p) => heuristicSummary(p, maxChars)));
    },
  };
}

/**
 * Heuristic-based summarization as fallback.
 */
function heuristicSummary(prompt: string, maxChars?: number): string {
  const effectiveMaxChars = maxChars || 200;
  // Extract the result section
  const resultMatch = prompt.match(/## Result[^`]*```[\s\S]*?```/);
  if (!resultMatch) {
    return prompt.slice(0, effectiveMaxChars);
  }

  const result = resultMatch[0]
    .replace(/## Result[^`]*```\n?/, "")
    .replace(/```$/, "")
    .trim();

  // Take first meaningful lines
  const lines = result.split("\n").filter((l) => l.trim());
  if (lines.length === 0) {
    return result.slice(0, effectiveMaxChars);
  }

  // Create a simple summary from first few lines
  const summary = lines.slice(0, 3).join(" ").trim();
  return summary.slice(0, effectiveMaxChars);
}
