/**
 * Enhanced RAG - 检索增强生成 2.0
 *
 * 实现：Self-RAG, Multi-hop RAG
 * 提供置信度评估和可执行建议
 */

import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getMemorySearchManager } from "../memory/index.js";
import type { MemorySearchResult } from "../memory/types.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import type { AnyAgentTool } from "./tools/common.js";
import { jsonResult, readNumberParam, readStringParam } from "./tools/common.js";

const log = createSubsystemLogger("rag");

export type SelfRAGResult = {
  answer: string;
  confidence: number;
  citations: Citation[];
  relevance: number;
  support: number;
  utility: number;
};

export type Citation = {
  text: string;
  source: string;
  score: number;
};

export type MultiHopResult = {
  answer: string;
  reasoningChain: ReasoningStep[];
  hops: number;
};

export type ReasoningStep = {
  step: number;
  question: string;
  evidence: string;
  conclusion: string;
};

type RAGRecommendation =
  | "proceed_high_confidence"
  | "proceed_moderate_confidence"
  | "low_relevance_expand"
  | "insufficient_gather_more"
  | "memory_unavailable"
  | "no_results"
  | "error";

type RAGContext = {
  cfg: OpenClawConfig;
  agentId: string;
};

function resolveRAGContext(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): RAGContext | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  return { cfg, agentId };
}

function calculateConfidence(
  results: MemorySearchResult[],
  query: string,
): {
  relevance: number;
  support: number;
  utility: number;
  confidence: number;
} {
  if (results.length === 0) {
    return { relevance: 0, support: 0, utility: 0, confidence: 0 };
  }

  const searchScores = results.map((r) => r.score ?? 0);
  const avgSearchScore =
    searchScores.reduce((a, b) => a + b, 0) / searchScores.length;

  const relevance = calculateRelevance(results, query);
  const support = calculateSupport(results, query);
  const utility = calculateUtility(query, results);

  const confidence = avgSearchScore * 0.4 + relevance * 0.3 + utility * 0.3;

  return {
    relevance: Math.round(relevance * 1000) / 1000,
    support: Math.round(support * 1000) / 1000,
    utility: Math.round(utility * 1000) / 1000,
    confidence: Math.min(1, Math.max(0, confidence)),
  };
}

function calculateRelevance(results: MemorySearchResult[], query: string): number {
  const queryTerms = extractKeyTerms(query);
  if (queryTerms.length === 0) {
    return 0.5;
  }

  const combinedText = results.map((r) => r.snippet).join(" ").toLowerCase();
  const matchedTerms = queryTerms.filter((term) => combinedText.includes(term));

  return matchedTerms.length / queryTerms.length;
}

function calculateSupport(results: MemorySearchResult[], query: string): number {
  const queryLower = query.toLowerCase();

  const hasQuantitative = /\d+[%$]?|\d+\.\d+/.test(queryLower);
  const hasComparison = /better|worse|more|less|higher|lower|best|worst/i.test(query);
  const hasTemporal = /when|date|time|recent|latest|before|after/i.test(query);

  const combinedText = results.map((r) => r.snippet).join(" ");

  let support = 0.5;

  if (hasQuantitative && /\d+[%$]?|\d+\.\d+/.test(combinedText)) {
    support += 0.2;
  }
  if (hasComparison && /better|worse|more|less|higher|lower|best|worst/i.test(combinedText)) {
    support += 0.2;
  }
  if (hasTemporal && /\d{4}|\d{1,2}\/\d{1,2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(combinedText)) {
    support += 0.2;
  }

  return Math.min(1, support);
}

function calculateUtility(query: string, results: MemorySearchResult[]): number {
  const resultLength = results.reduce((sum, r) => sum + r.snippet.length, 0);

  let utility = 0.3;

  if (resultLength > 500) {
    utility += 0.3;
  } else if (resultLength > 200) {
    utility += 0.2;
  } else if (resultLength > 50) {
    utility += 0.1;
  }

  if (/how|what|why|when|where|which|explain|describe/i.test(query)) {
    utility += 0.2;
  }

  if (results.length >= 3) {
    utility += 0.2;
  } else if (results.length >= 2) {
    utility += 0.1;
  }

  return Math.min(1, utility);
}

function extractKeyTerms(text: string): string[] {
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "must",
    "shall",
    "can",
    "need",
    "dare",
    "ought",
    "used",
    "to",
    "of",
    "in",
    "for",
    "on",
    "with",
    "at",
    "by",
    "from",
    "as",
    "into",
    "through",
    "during",
    "before",
    "after",
    "above",
    "below",
    "between",
    "under",
    "again",
    "further",
    "then",
    "once",
    "here",
    "there",
    "when",
    "where",
    "why",
    "how",
    "all",
    "each",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "no",
    "nor",
    "not",
    "only",
    "own",
    "same",
    "so",
    "than",
    "too",
    "very",
    "just",
    "and",
    "but",
    "if",
    "or",
    "because",
    "until",
    "while",
    "about",
    "what",
    "which",
    "who",
    "whom",
    "this",
    "that",
    "these",
    "those",
  ]);

  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word))
    .filter((word) => /^[a-z0-9]+$/.test(word));
}

function getRecommendation(
  confidence: number,
  relevance: number,
): RAGRecommendation {
  if (confidence >= 0.7 && relevance >= 0.6) {
    return "proceed_high_confidence";
  }
  if (confidence >= 0.5) {
    return "proceed_moderate_confidence";
  }
  if (relevance < 0.3) {
    return "low_relevance_expand";
  }
  return "insufficient_gather_more";
}

function getSuggestion(recommendation: RAGRecommendation, confidence: number): string {
  const pct = `${Math.round(confidence * 100)}%`;

  switch (recommendation) {
    case "proceed_high_confidence":
      return `High confidence (${pct}). Proceed with answer using retrieved context. Cite sources when appropriate.`;
    case "proceed_moderate_confidence":
      return `Moderate confidence (${pct}). Verify key claims. Consider additional memory_search with alternative terms if uncertain.`;
    case "low_relevance_expand":
      return `Low relevance. Try: (1) broader search terms, (2) alternative keywords, (3) web_search for external information.`;
    case "insufficient_gather_more":
      return `Insufficient context. Try: (1) multihop_rag for related topics, (2) web_search, (3) ask user for clarification.`;
    case "memory_unavailable":
      return "Memory system unavailable. Check configuration or use web_search as fallback.";
    case "no_results":
      return "No results found. Check if relevant information exists in memory or use web_search.";
    default:
      return "Review retrieved context before proceeding.";
  }
}

function getActionItems(recommendation: RAGRecommendation): string[] {
  switch (recommendation) {
    case "proceed_high_confidence":
      return [
        "Synthesize answer from retrieved context",
        "Include citations for key claims",
        "No additional search needed",
      ];
    case "proceed_moderate_confidence":
      return [
        "Cross-check key facts",
        "Consider memory_search with alternative terms",
        "Mark uncertain claims explicitly",
      ];
    case "low_relevance_expand":
      return [
        "memory_search with broader terms",
        "Try web_search for external sources",
        "Ask user for more specific query",
      ];
    case "insufficient_gather_more":
      return [
        "Use multihop_rag for related topics",
        "Use web_search for additional context",
        "Ask user clarifying questions",
      ];
    default:
      return ["Review available information"];
  }
}

export function createSelfRAGTool(options?: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveRAGContext(options ?? {});
  if (!ctx) {
    return null;
  }
  const { cfg, agentId } = ctx;

  return {
    name: "self_rag",
    label: "Self-RAG",
    description:
      "Search memory with quality assessment. Returns context with confidence score and actionable recommendations. Use before answering questions about prior work, decisions, or domain knowledge.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The question or query to search for",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of results to retrieve (default: 5)",
        },
        minScore: {
          type: "number",
          description: "Minimum relevance score threshold 0-1 (default: 0.3)",
        },
      },
      required: ["query"],
    },
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const maxResults = readNumberParam(params, "maxResults") ?? 5;
      const minScore = readNumberParam(params, "minScore") ?? 0.3;

      log.debug(`self_rag: query="${query.substring(0, 50)}..." maxResults=${maxResults}`);

      const { manager, error } = await getMemorySearchManager({ cfg, agentId });
      if (!manager) {
        log.warn(`self_rag: memory unavailable: ${error}`);
        return jsonResult({
          results: [],
          confidence: 0,
          assessment: { relevance: 0, support: 0, utility: 0 },
          recommendation: "memory_unavailable",
          actionItems: getActionItems("memory_unavailable"),
          suggestion: getSuggestion("memory_unavailable", 0),
          error,
        });
      }

      try {
        const searchResults = await manager.search(query, { maxResults, minScore });

        if (searchResults.length === 0) {
          log.debug(`self_rag: no results for query`);
          return jsonResult({
            results: [],
            confidence: 0,
            assessment: { relevance: 0, support: 0, utility: 0 },
            recommendation: "no_results",
            actionItems: getActionItems("no_results"),
            suggestion: getSuggestion("no_results", 0),
            query,
          });
        }

        const assessment = calculateConfidence(searchResults, query);
        const recommendation = getRecommendation(assessment.confidence, assessment.relevance);
        const suggestion = getSuggestion(recommendation, assessment.confidence);
        const actionItems = getActionItems(recommendation);

        log.debug(
          `self_rag: ${searchResults.length} results, confidence=${assessment.confidence.toFixed(2)}, recommendation=${recommendation}`,
        );

        return jsonResult({
          results: searchResults.map((r) => ({
            snippet: r.snippet,
            path: r.path,
            citation: `${r.path}#L${r.startLine}-L${r.endLine}`,
            score: r.score,
          })),
          confidence: Math.round(assessment.confidence * 1000) / 1000,
          assessment: {
            relevance: assessment.relevance,
            support: assessment.support,
            utility: assessment.utility,
          },
          recommendation,
          actionItems,
          suggestion,
          query,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`self_rag error: ${message}`);
        return jsonResult({
          results: [],
          confidence: 0,
          assessment: { relevance: 0, support: 0, utility: 0 },
          recommendation: "error",
          actionItems: [],
          suggestion: `Error occurred: ${message}`,
          error: message,
          query,
        });
      }
    },
  };
}

function generateSubQuestions(question: string, maxHops: number): string[] {
  const subQuestions: string[] = [question];

  const keyTerms = extractKeyTerms(question);
  const hasHow = /\bhow\b/i.test(question);
  const hasWhy = /\bwhy\b/i.test(question);
  const hasWhat = /\bwhat\b/i.test(question);
  const hasWhen = /\bwhen\b/i.test(question);

  if (keyTerms.length > 0 && maxHops > 1) {
    const topTerms = keyTerms.slice(0, 3).join(" ");

    if (hasHow || hasWhat) {
      subQuestions.push(`background context for ${topTerms}`);
    }

    if (hasWhy) {
      subQuestions.push(`reasons and motivations for ${topTerms}`);
    }

    if (hasWhen) {
      subQuestions.push(`timeline and history of ${topTerms}`);
    }

    if (!hasHow && !hasWhy && !hasWhat && !hasWhen) {
      subQuestions.push(`related decisions and outcomes about ${topTerms}`);
    }
  }

  if (subQuestions.length < maxHops && keyTerms.length > 2) {
    subQuestions.push(`dependencies and prerequisites for ${keyTerms.slice(0, 2).join(" and ")}`);
  }

  return subQuestions.slice(0, maxHops);
}

export function createMultiHopRAGTool(options?: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveRAGContext(options ?? {});
  if (!ctx) {
    return null;
  }
  const { cfg, agentId } = ctx;

  return {
    name: "multihop_rag",
    label: "Multi-hop RAG",
    description:
      "Multi-hop reasoning for complex questions. Executes iterative searches across related queries to build comprehensive evidence. Returns reasoning chain with gathered context.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The complex question requiring multi-hop reasoning",
        },
        maxHops: {
          type: "number",
          description: "Maximum number of reasoning hops (default: 3)",
        },
        subQuestions: {
          type: "array",
          items: { type: "string" },
          description: "Optional custom sub-questions to investigate",
        },
      },
      required: ["question"],
    },
    execute: async (_toolCallId, params) => {
      const question = readStringParam(params, "question", { required: true });
      const maxHops = readNumberParam(params, "maxHops") ?? 3;
      const customSubQuestions = params.subQuestions as string[] | undefined;

      log.debug(`multihop_rag: question="${question.substring(0, 50)}..." maxHops=${maxHops}`);

      const { manager, error } = await getMemorySearchManager({ cfg, agentId });
      if (!manager) {
        log.warn(`multihop_rag: memory unavailable: ${error}`);
        return jsonResult({
          reasoningChain: [],
          hops: 0,
          totalResults: 0,
          status: "memory_unavailable",
          error,
          question,
        });
      }

      try {
        const reasoningChain: Array<{
          step: number;
          query: string;
          results: Array<{ snippet: string; path: string; score: number }>;
          confidence: number;
          conclusion: string;
        }> = [];

        const queries =
          customSubQuestions ?? generateSubQuestions(question, maxHops);

        let totalResults = 0;
        let aggregatedConfidence = 0;

        for (let hop = 0; hop < Math.min(queries.length, maxHops); hop++) {
          const subQuery = queries[hop];
          const results = await manager.search(subQuery, { maxResults: 3 });

          const assessment = calculateConfidence(results, subQuery);

          totalResults += results.length;
          aggregatedConfidence += assessment.confidence;

          const conclusion =
            results.length > 0
              ? `Found ${results.length} relevant results (confidence: ${Math.round(assessment.confidence * 100)}%)`
              : "No relevant results found";

          reasoningChain.push({
            step: hop + 1,
            query: subQuery,
            results: results.map((r) => ({
              snippet: r.snippet.substring(0, 300),
              path: r.path,
              score: r.score,
            })),
            confidence: Math.round(assessment.confidence * 1000) / 1000,
            conclusion,
          });
        }

        const avgConfidence =
          reasoningChain.length > 0
            ? aggregatedConfidence / reasoningChain.length
            : 0;

        const status = totalResults > 0 ? "evidence_gathered" : "no_evidence";

        const nextAction =
          totalResults > 0
            ? "Synthesize answer from reasoning chain. Cite relevant sources."
            : "Try web_search or ask user for clarification.";

        log.debug(
          `multihop_rag: ${reasoningChain.length} hops, ${totalResults} total results, avg confidence=${avgConfidence.toFixed(2)}`,
        );

        return jsonResult({
          reasoningChain,
          hops: reasoningChain.length,
          totalResults,
          avgConfidence: Math.round(avgConfidence * 1000) / 1000,
          status,
          nextAction,
          question,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`multihop_rag error: ${message}`);
        return jsonResult({
          reasoningChain: [],
          hops: 0,
          totalResults: 0,
          status: "error",
          error: message,
          question,
        });
      }
    },
  };
}

export function createEnhancedRAGTools(options?: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): (AnyAgentTool | null)[] {
  return [createSelfRAGTool(options), createMultiHopRAGTool(options)];
}

export { type SelfRAGResult as SelfRAGResultType, type MultiHopResult as MultiHopResultType };
