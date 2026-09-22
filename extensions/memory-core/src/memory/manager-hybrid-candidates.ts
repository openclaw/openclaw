import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { KeywordSearchHit } from "./manager-keyword-retrieval.js";
import { prepareExactPathMatcher } from "./manager-search.js";

export function projectHybridCandidates(
  query: string,
  vector: Array<MemorySearchResult & { id: string }>,
  keyword: KeywordSearchHit[],
) {
  const matchExactPath = prepareExactPathMatcher(query);
  return {
    vector: vector.map((result) => ({
      id: result.id,
      path: result.path,
      startLine: result.startLine,
      endLine: result.endLine,
      source: result.source,
      snippet: result.snippet,
      vectorScore: result.score,
      importance: result.importance,
      triggers: result.triggers,
      projectKey: result.projectKey,
      exactPathSpecificity: matchExactPath(result.path),
      ...(result.provenance ? { provenance: result.provenance } : {}),
    })),
    keyword: keyword.map((result) => ({
      id: result.id,
      path: result.path,
      startLine: result.startLine,
      endLine: result.endLine,
      source: result.source,
      snippet: result.snippet,
      textScore: result.textScore,
      hasBodyMatch: result.hasBodyMatch,
      importance: result.importance,
      triggers: result.triggers,
      projectKey: result.projectKey,
      rankingScore: result.score,
      pathScore: result.pathScore,
      exactPathSpecificity: result.exactPathSpecificity,
      ...(result.provenance ? { provenance: result.provenance } : {}),
    })),
  };
}
