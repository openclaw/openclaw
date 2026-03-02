/**
 * Retrieval logic for tool result summary store.
 *
 * Handles searching and formatting relevant tool results for context injection.
 */

import type { EmbeddingProvider } from "../../../memory/embeddings.js";
import type { ToolResultSummaryStore } from "./store.js";
import { extractTextContent } from "./summarizer.js";
import type { ToolResultSearchResult, RetrievalConfig } from "./types.js";

/**
 * Formatted retrieval result for context injection.
 */
export type FormattedRetrievalResult = {
  /** The formatted context block */
  contextBlock: string;
  /** The number of results retrieved */
  count: number;
  /** The raw search results */
  results: ToolResultSearchResult[];
};

/**
 * Create a retriever instance.
 */
export function createRetriever(
  config: RetrievalConfig,
  store: ToolResultSummaryStore,
  _embeddings: EmbeddingProvider,
) {
  return {
    /**
     * Retrieve relevant tool results for a query.
     */
    async retrieve(
      query: string,
      options?: { sessionId?: string },
    ): Promise<ToolResultSearchResult[]> {
      return store.search(query, {
        limit: config.maxResults,
        minScore: config.minScore,
        sessionId: options?.sessionId,
        crossSession: config.crossSessionSearch,
      });
    },

    /**
     * Retrieve and format tool results for context injection.
     */
    async retrieveAndFormat(
      query: string,
      options?: { sessionId?: string },
    ): Promise<FormattedRetrievalResult> {
      const results = await this.retrieve(query, options);

      if (results.length === 0) {
        return { contextBlock: "", count: 0, results: [] };
      }

      const contextBlock = formatResultsForContext(
        results,
        config.injectFullContent,
        config.maxFullContentChars,
      );

      return { contextBlock, count: results.length, results };
    },
  };
}

/**
 * Format search results into a context block for the LLM.
 */
export function formatResultsForContext(
  results: ToolResultSearchResult[],
  includeFullContent: boolean,
  maxContentChars: number,
): string {
  const lines: string[] = [
    "<relevant-tool-results>",
    "The following previously executed tool results may be relevant to your current task:",
    "",
  ];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const score = Math.round(r.score * 100);
    const errorTag = r.entry.isError ? " [ERROR]" : "";

    lines.push(`${i + 1}. [${r.entry.toolName}] ${r.entry.summary}${errorTag} (${score}% match)`);

    if (includeFullContent) {
      const fullContent = extractTextContent(r.entry.originalContent);
      if (fullContent.length > 0) {
        const truncated = fullContent.slice(0, maxContentChars);
        const ellipsis = fullContent.length > maxContentChars ? "..." : "";
        lines.push(`   Full result:`);
        lines.push(`   ${truncated}${ellipsis}`);
      }
    }

    // Include input parameters for context
    const inputStr = formatInput(r.entry.input);
    if (inputStr) {
      lines.push(`   Input: ${inputStr}`);
    }

    lines.push("");
  }

  lines.push("</relevant-tool-results>");
  return lines.join("\n");
}

/**
 * Format input parameters for display.
 */
function formatInput(input: Record<string, unknown>): string {
  const parts: string[] = [];

  // Common fields to show
  if (typeof input["file_path"] === "string") {
    parts.push(`file=${input["file_path"]}`);
  }
  if (typeof input["pattern"] === "string") {
    parts.push(`pattern="${input["pattern"]}"`);
  }
  if (typeof input["command"] === "string") {
    parts.push(`cmd="${input["command"].slice(0, 50)}"`);
  }
  if (typeof input["path"] === "string") {
    parts.push(`path=${input["path"]}`);
  }

  if (parts.length === 0) {
    // Fallback to generic format
    const keys = Object.keys(input).slice(0, 3);
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string") {
        parts.push(`${key}="${value.slice(0, 30)}"`);
      } else if (typeof value === "number" || typeof value === "boolean") {
        parts.push(`${key}=${value}`);
      }
    }
  }

  return parts.join(", ");
}

/**
 * Build a search query from current context.
 * Combines user prompt with recent tool calls for better retrieval.
 */
export function buildSearchQuery(params: {
  prompt: string;
  recentToolCalls?: Array<{ toolName: string; input: Record<string, unknown> }>;
}): string {
  // Start with the user's prompt
  const promptPart = params.prompt.trim();

  // Add context from recent tool calls
  const toolParts: string[] = [];
  if (params.recentToolCalls && params.recentToolCalls.length > 0) {
    for (const call of params.recentToolCalls.slice(0, 3)) {
      toolParts.push(`${call.toolName}: ${JSON.stringify(call.input).slice(0, 100)}`);
    }
  }

  if (toolParts.length > 0) {
    return `${promptPart}\n\nContext: ${toolParts.join("; ")}`;
  }

  return promptPart;
}
