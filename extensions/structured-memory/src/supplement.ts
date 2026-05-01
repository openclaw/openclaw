import type {
  MemoryCorpusSupplement,
  MemoryCorpusSearchResult,
  MemoryCorpusGetResult,
} from "openclaw/plugin-sdk/memory-state";
import type { ResolvedStructuredMemoryConfig } from "./config";
import { findRecordById, findRecords, getOrOpenDatabase } from "./db";
import { computeRelevance } from "./decay";
import type { RecordFindResult } from "./types";

function mapToSearchResult(item: RecordFindResult): MemoryCorpusSearchResult {
  const { record, relevance } = item;
  return {
    corpus: "structured-memory",
    path: `records/${record.id}`,
    title: record.summary,
    score: relevance.relevance,
    snippet: record.summary,
    id: record.id,
    updatedAt: record.updated_at,
  };
}

export function createStructuredMemorySupplement(params: {
  config: ResolvedStructuredMemoryConfig;
}): MemoryCorpusSupplement {
  return {
    search: async (input) => {
      const agentId = extractAgentId(input.agentSessionKey);
      const db = getOrOpenDatabase(agentId);

      const query = input.query;
      const rawRecords = findRecords(db, {
        keywords_contains: query,
        text_contains: query,
        max_results: input.maxResults ?? params.config.recall.maxResults,
        status: "active",
      });

      const results: RecordFindResult[] = rawRecords.map((record) => ({
        record,
        relevance: computeRelevance(record, { decay: params.config.decay }),
      }));

      results.sort((a, b) => b.relevance.relevance - a.relevance.relevance);
      return results.map(mapToSearchResult);
    },
    get: async (input) => {
      const agentId = extractAgentId(input.agentSessionKey);
      const db = getOrOpenDatabase(agentId);

      let record = findRecordById(db, input.lookup);
      if (!record) {
        const matches = findRecords(db, {
          keywords_contains: input.lookup,
          max_results: 1,
          status: "active",
        });
        record = matches[0] ?? null;
      }
      if (!record) return null;

      const result: MemoryCorpusGetResult = {
        corpus: "structured-memory",
        path: `records/${record.id}`,
        title: record.summary,
        kind: record.type,
        content: record.content ?? record.summary,
        fromLine: 1,
        lineCount: 1,
        id: record.id,
        updatedAt: record.updated_at,
      };
      return result;
    },
  };
}

function extractAgentId(agentSessionKey?: string): string {
  if (!agentSessionKey) return "main";
  const parts = agentSessionKey.split(":");
  const agentIdx = parts.indexOf("agent");
  if (agentIdx >= 0 && agentIdx + 1 < parts.length) {
    return parts[agentIdx + 1];
  }
  return "main";
}
