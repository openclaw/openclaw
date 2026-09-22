// Memory Core plugin module owns keyword retrieval and ranking.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createSubsystemLogger,
  resolveUserPath,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { extractKeywords } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
  type MemorySearchResult,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { buildFtsQuery, scoreExactPathTieForTemporalDecay } from "./hybrid.js";
import { applyImportanceMultiplier } from "./importance.js";
import {
  runMemoryCuratedCandidates,
  runMemoryKeywordSearch,
  runMemoryRecallMetadata,
} from "./manager-cpu-worker-runtime.js";
import { MemoryProviderLifecycle } from "./manager-provider-lifecycle.js";
import { readMemoryRecallData } from "./manager-retrieval-read.js";
import { prepareExactPathMatcher, type ExactPathSpecificity } from "./manager-search.js";
import type {
  MemoryKeywordWorkerQuery,
  MemoryKeywordWorkerResult,
} from "./manager-search.worker.js";
import {
  applyProjectRanking,
  prepareActiveProjectKeys,
  projectScoreMultiplier,
} from "./project-ranking.js";
import { applyTemporalDecayToHybridResults } from "./temporal-decay.js";

const SNIPPET_MAX_CHARS = 700;
const FTS_TABLE = MEMORY_INDEX_FTS_TABLE;
const PATH_FTS_TABLE = MEMORY_INDEX_PATHS_FTS_TABLE;
const KEYWORD_FALLBACK_SEARCH_TERM_LIMIT = 6;
const EXACT_PATH_CANDIDATE_LIMIT = 200;
const log = createSubsystemLogger("memory");

export type MemoryRetrievalResult = MemorySearchResult & { sourceMtime?: number };

export type KeywordSearchHit = MemoryRetrievalResult & {
  id: string;
  textScore: number;
  pathScore: number;
  exactPathSpecificity: ExactPathSpecificity;
  hasBodyMatch: boolean;
};

type KeywordSearchOptions = {
  boostFallbackRanking?: boolean;
  signal?: AbortSignal;
  exactPathQuery?: string;
  rankingQuery?: string;
};

function keywordHitHasBody(hit: KeywordSearchHit): boolean {
  return hit.hasBodyMatch;
}

function compareKeywordSearchHits(
  a: KeywordSearchHit,
  b: KeywordSearchHit,
  preferExactBody = true,
): number {
  const specificityDelta = b.exactPathSpecificity - a.exactPathSpecificity;
  if (specificityDelta !== 0) {
    return specificityDelta;
  }
  if (preferExactBody && a.exactPathSpecificity > 0) {
    const bodyPresenceDelta = Number(keywordHitHasBody(b)) - Number(keywordHitHasBody(a));
    if (bodyPresenceDelta !== 0) {
      return bodyPresenceDelta;
    }
  }
  // Score carries body relevance plus any configured decay. Exact tiers ignore
  // path BM25 because specificity already owns path precedence.
  const relevanceDelta = b.score - a.score;
  if (relevanceDelta !== 0) {
    return relevanceDelta;
  }
  const textDelta = b.textScore - a.textScore;
  if (textDelta !== 0) {
    return textDelta;
  }
  if (a.exactPathSpecificity === 0) {
    const pathDelta = b.pathScore - a.pathScore;
    if (pathDelta !== 0) {
      return pathDelta;
    }
  }
  return a.path.localeCompare(b.path) || a.startLine - b.startLine || a.id.localeCompare(b.id);
}

export abstract class MemoryKeywordRetrieval extends MemoryProviderLifecycle {
  private selectScoredResults<T extends MemorySearchResult & { score: number }>(
    results: T[],
    maxResults: number,
    minScore: number,
    relaxedMinScore = minScore,
  ): T[] {
    const strict = results.filter((entry) => entry.score >= minScore);
    if (strict.length > 0) {
      return strict.slice(0, maxResults);
    }
    return results.filter((entry) => entry.score >= relaxedMinScore).slice(0, maxResults);
  }

  async listTriggerCandidates(opts?: {
    limit?: number;
    activeProjectKeys?: string[];
  }): Promise<MemorySearchResult[]> {
    const limit = Math.max(1, Math.min(512, Math.floor(opts?.limit ?? 512)));
    return await this.readCuratedMemoryCandidates({
      limit,
      projectsOnly: false,
      activeProjectKeys: opts?.activeProjectKeys,
    });
  }

  async listCuratedProjectCandidates(opts: {
    activeProjectKeys: string[];
    limit?: number;
  }): Promise<MemorySearchResult[]> {
    const limit = Math.max(1, Math.min(512, Math.floor(opts.limit ?? 48)));
    return await this.readCuratedMemoryCandidates({
      limit,
      projectsOnly: true,
      activeProjectKeys: opts.activeProjectKeys,
    });
  }

  private async readCuratedMemoryCandidates(query: {
    limit: number;
    projectsOnly: boolean;
    activeProjectKeys?: string[];
  }): Promise<MemorySearchResult[]> {
    return await this.withManagerOperation(async () => {
      const result = await runMemoryCuratedCandidates(
        {
          agentId: this.agentId,
          databasePath: resolveUserPath(this.settings.store.databasePath),
        },
        { ...query, checkProvenanceRepair: this.memorySourceProvenanceRepairPending },
      );
      this.memorySourceProvenanceRepairPending = result.provenanceRepairPending;
      if (this.memorySourceProvenanceRepairPending) {
        // Automatic recall runs before the model. Keep repair admitted for teardown
        // without holding the reply; unclassified sources stay excluded.
        void this.withManagerOperation(() =>
          this.syncAdmitted({ reason: "search" }, { allowEmbeddingBootstrapFallback: true }),
        ).catch((err: unknown) => {
          log.warn(`memory sync failed (automatic candidates): ${formatErrorMessage(err)}`);
        });
        return [];
      }
      return this.toCuratedMemorySearchResults(result.rows);
    });
  }

  private toCuratedMemorySearchResults(
    rows: Awaited<ReturnType<typeof runMemoryCuratedCandidates>>["rows"],
  ): MemorySearchResult[] {
    return rows.map((row) => {
      const result: MemorySearchResult = {
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        score: 0,
        snippet: row.text,
        source: "memory",
      };
      if (typeof row.importance === "number") {
        result.importance = row.importance;
      }
      if (typeof row.triggers === "string" && row.triggers.trim()) {
        result.triggers = row.triggers.trim();
      }
      if (typeof row.project_key === "string" && row.project_key.trim()) {
        result.projectKey = row.project_key.trim();
      }
      result.provenance = {
        originClass: row.origin_class,
        sessionKind: row.session_kind,
        observedAt: row.observed_at,
        ...(typeof row.supersedes_key === "string" ? { supersedesKey: row.supersedes_key } : {}),
      };
      return result;
    });
  }

  protected async finalizeKeywordOnlyResults(params: {
    results: KeywordSearchHit[];
    temporalDecay?: { enabled: boolean; halfLifeDays: number };
    maxResults: number;
    minScore: number;
    activeProjectKeys?: readonly string[];
  }): Promise<MemoryRetrievalResult[]> {
    const appliesTemporalDecay = params.temporalDecay?.enabled === true;
    const decayInputs = appliesTemporalDecay
      ? params.results.map((entry) => {
          if (entry.exactPathSpecificity === 0) {
            return entry;
          }
          const contentScore = keywordHitHasBody(entry) ? entry.score : 0;
          return { ...entry, score: scoreExactPathTieForTemporalDecay(contentScore) };
        })
      : params.results;
    const decayed = await applyTemporalDecayToHybridResults({
      results: decayInputs,
      temporalDecay: params.temporalDecay,
      workspaceDir: this.workspaceDir,
      sessionSourceMtimes: this.loadSessionSourceMtimes(params.results),
      memorySourceMtimes: this.loadRemoteMemorySourceMtimes(params.results),
    });
    // Preserve specificity and adjusted body relevance before normalizing exact public scores.
    const activeProjects = prepareActiveProjectKeys(params.activeProjectKeys);
    const ranked = applyProjectRanking(applyImportanceMultiplier(decayed), activeProjects)
      .toSorted((left, right) => compareKeywordSearchHits(left, right, !appliesTemporalDecay))
      .map((entry) =>
        entry.exactPathSpecificity > 0
          ? Object.assign(entry, {
              score: projectScoreMultiplier(entry.projectKey, activeProjects),
            })
          : entry,
      );
    return this.toMemorySearchResults(
      this.selectScoredResults(ranked, params.maxResults, params.minScore, 0),
    );
  }

  protected loadRemoteMemorySourceMtimes(
    results: ReadonlyArray<Pick<MemoryRetrievalResult, "path" | "source" | "sourceMtime">>,
  ): ReadonlyMap<string, number | undefined> | undefined {
    if (!this.memoryFiles) {
      return undefined;
    }
    const entries = results.filter((entry) => entry.source === "memory");
    if (entries.length === 0) {
      return undefined;
    }
    return new Map(entries.map((entry) => [entry.path, entry.sourceMtime]));
  }

  protected loadSessionSourceMtimes(
    results: ReadonlyArray<Pick<MemoryRetrievalResult, "path" | "source" | "sourceMtime">>,
  ): ReadonlyMap<string, number | undefined> | undefined {
    const entries = results.filter((entry) => entry.source === "sessions");
    if (entries.length === 0) {
      return undefined;
    }
    return new Map(entries.map((entry) => [entry.path, entry.sourceMtime]));
  }

  protected async attachRecallMetadata<T extends MemoryRetrievalResult & { id: string }>(
    results: T[],
    signal?: AbortSignal,
    sourceFilterList?: MemorySource[],
  ): Promise<T[]> {
    if (results.length === 0) {
      return results;
    }
    const query = {
      candidates: results.map(({ id, path, source }) => ({ id, path, source })),
      includeMemoryMtimes: Boolean(this.memoryFiles),
    };
    // The 50k-chunk benchmark regressed session-only latency by 3.22 ms when
    // offloaded (10.87 -> 14.10 ms), beyond a worker hop. Keep its final freshness
    // read local until retrieval and enrichment can share one admitted request.
    const sessionOnly = sourceFilterList?.length === 1 && sourceFilterList[0] === "sessions";
    const { rows: metadataById, sourceMtimes } = sessionOnly
      ? readMemoryRecallData(this.db, query)
      : await runMemoryRecallMetadata(
          {
            agentId: this.agentId,
            databasePath: resolveUserPath(this.settings.store.databasePath),
          },
          query,
          signal,
        );
    // The left-joined metadata reader omits only missing chunks. A forget may
    // delete one while the worker is reading its earlier snapshot.
    return results
      .filter((entry) => metadataById.has(entry.id))
      .map((entry) => {
        const row = metadataById.get(entry.id);
        return Object.assign(entry, {
          sourceMtime: sourceMtimes[entry.source].get(entry.path),
          ...(typeof row?.importance === "number" ? { importance: row.importance } : {}),
          ...(typeof row?.triggers === "string" && row.triggers.trim()
            ? { triggers: row.triggers.trim() }
            : {}),
          ...(typeof row?.project_key === "string" && row.project_key.trim()
            ? { projectKey: row.project_key.trim() }
            : {}),
          ...(row?.provenance ? { provenance: row.provenance } : {}),
        });
      });
  }

  private buildKeywordSearchQuery(
    query: string,
    limit: number,
    options?: KeywordSearchOptions,
    sourceFilterList?: MemorySource[],
  ): MemoryKeywordWorkerQuery {
    return {
      body: {
        ftsTable: FTS_TABLE,
        query,
        ftsTokenizer: this.settings.store.fts.tokenizer,
        limit,
        snippetMaxChars: SNIPPET_MAX_CHARS,
        sourceFilter: this.buildSourceFilter(undefined, sourceFilterList),
        boostFallbackRanking: options?.boostFallbackRanking,
        rankingQuery: options?.rankingQuery,
      },
      path: {
        pathFtsTable: PATH_FTS_TABLE,
        query,
        exactPathQuery: options?.exactPathQuery ?? query,
        exactPathLimit: EXACT_PATH_CANDIDATE_LIMIT,
        ftsTokenizer: this.settings.store.fts.tokenizer,
        limit,
        snippetMaxChars: SNIPPET_MAX_CHARS,
        sourceFilter: this.buildSourceFilter(PATH_FTS_TABLE, sourceFilterList),
      },
    };
  }

  protected async prepareKeywordSearch(
    query: string,
    limit: number,
    options: KeywordSearchOptions,
    sourceFilterList: MemorySource[],
  ) {
    const result = await runMemoryKeywordSearch(
      { agentId: this.agentId, databasePath: resolveUserPath(this.settings.store.databasePath) },
      this.buildKeywordSearchQuery(query, limit, options, sourceFilterList),
      options.signal,
      true,
    );
    if (!result.indexState) {
      throw new Error("Memory keyword preparation returned no index state");
    }
    return { indexState: result.indexState, keyword: result };
  }

  private async searchKeyword(
    query: string,
    limit: number,
    options?: KeywordSearchOptions,
    sourceFilterList?: MemorySource[],
  ): Promise<KeywordSearchHit[]> {
    if (!this.fts.enabled || !this.fts.available) {
      return [];
    }
    const result = await runMemoryKeywordSearch(
      { agentId: this.agentId, databasePath: resolveUserPath(this.settings.store.databasePath) },
      this.buildKeywordSearchQuery(query, limit, options, sourceFilterList),
      options?.signal,
    );
    return this.resolveKeywordSearchResult(result, options?.exactPathQuery ?? query, limit);
  }

  private resolveKeywordSearchResult(
    result: MemoryKeywordWorkerResult,
    exactPathQuery: string,
    limit: number,
  ): KeywordSearchHit[] {
    if (result.body.error) {
      log.warn(`memory search: body keyword query failed: ${result.body.error}`);
    }
    if (result.path.error) {
      log.warn(`memory search: path keyword query failed: ${result.path.error}`);
    }
    const bodyResults = result.body.rows;
    const pathResults = result.path.rows;
    const merged = this.mergeKeywordSearchHits(
      [bodyResults.map((entry) => Object.assign(entry, { pathScore: 0 })), pathResults],
      exactPathQuery,
    );
    return this.limitKeywordSearchHits(merged, limit);
  }

  protected async searchKeywordWithFallback(
    query: string,
    limit: number,
    options: { boostFallbackRanking?: boolean; signal?: AbortSignal } | undefined,
    sourceFilterList: MemorySource[],
    initialResult?: MemoryKeywordWorkerResult,
  ): Promise<KeywordSearchHit[]> {
    const fullQueryResults = initialResult
      ? this.resolveKeywordSearchResult(initialResult, query, limit)
      : await this.searchKeyword(query, limit, options, sourceFilterList);
    options?.signal?.throwIfAborted();
    const nonExactResults = fullQueryResults.filter((result) => result.exactPathSpecificity === 0);
    if (nonExactResults.length >= limit) {
      return this.attachRecallMetadata(fullQueryResults, options?.signal, sourceFilterList);
    }

    // Supplement thin candidate pools for conversational queries, but cap the
    // extra FTS probes so long prompts cannot fan out into unbounded sqlite work.
    const fallbackTerms = this.resolveKeywordFallbackTerms(query);
    if (fallbackTerms.length === 0) {
      return this.attachRecallMetadata(fullQueryResults, options?.signal, sourceFilterList);
    }
    const strictFtsQuery = buildFtsQuery(query)?.toLowerCase();
    const keywordFtsQuery = buildFtsQuery(fallbackTerms.join(" "))?.toLowerCase();
    if (fullQueryResults.length > 0 && strictFtsQuery === keywordFtsQuery) {
      // Expansion did not normalize this already-matching keyword query; OR
      // probes can only weaken its strict relevance before importance ranking.
      return this.attachRecallMetadata(fullQueryResults, options?.signal, sourceFilterList);
    }

    const settled = await Promise.allSettled(
      fallbackTerms.map((term) =>
        this.searchKeyword(
          term,
          limit,
          { ...options, exactPathQuery: query, rankingQuery: query },
          sourceFilterList,
        ),
      ),
    );
    options?.signal?.throwIfAborted();
    // Keep the generation leased until every admitted probe has closed its reader,
    // including siblings of a failed or cancelled worker request.
    const resultSets = settled.map((result) => {
      if (result.status === "rejected") {
        throw result.reason;
      }
      return result.value;
    });
    // Enrich only the retained candidates after all probes deduplicate. Provenance
    // and recall annotations share one read under the search generation lease.
    return this.attachRecallMetadata(
      this.limitKeywordSearchHits(
        this.mergeKeywordSearchHits([fullQueryResults, ...resultSets], query),
        limit,
      ),
      options?.signal,
      sourceFilterList,
    );
  }

  private resolveKeywordFallbackTerms(query: string): string[] {
    const normalizedQuery = query.trim().toLowerCase();
    const keywords = extractKeywords(query, {
      ftsTokenizer: this.settings.store.fts.tokenizer,
    }).filter((term) => term !== normalizedQuery);
    return keywords.slice(0, KEYWORD_FALLBACK_SEARCH_TERM_LIMIT);
  }

  private mergeKeywordSearchHits(
    resultSets: Omit<KeywordSearchHit, "exactPathSpecificity">[][],
    exactPathQuery: string,
  ): KeywordSearchHit[] {
    // Fallback terms broaden lexical recall, but only the original user query
    // can claim exact path, basename, or stem precedence.
    const matchExactPath = prepareExactPathMatcher(exactPathQuery);
    const seenIds = new Map<string, KeywordSearchHit>();
    for (const results of resultSets) {
      for (const result of results) {
        const existing = seenIds.get(result.id);
        if (!existing) {
          seenIds.set(
            result.id,
            Object.assign(result, { exactPathSpecificity: matchExactPath(result.path) }),
          );
          continue;
        }
        const existingHasBody = keywordHitHasBody(existing);
        const resultHasBody = result.hasBodyMatch;
        const existingBodyScore = existingHasBody ? existing.score : 0;
        const resultBodyScore = resultHasBody ? result.score : 0;
        existing.textScore = Math.max(existing.textScore, result.textScore);
        existing.pathScore = Math.max(existing.pathScore, result.pathScore);
        existing.hasBodyMatch ||= result.hasBodyMatch;
        const bodyScore = Math.max(existingBodyScore, resultBodyScore);
        existing.score = bodyScore > 0 ? bodyScore : existing.pathScore;
        // Path hits project the first chunk; keep a real body-match snippet
        // authoritative when both retrieval surfaces find the same document.
        if (
          (resultHasBody && !existingHasBody) ||
          (resultHasBody === existingHasBody && result.snippet.length > existing.snippet.length)
        ) {
          existing.snippet = result.snippet;
        }
      }
    }
    const merged = [...seenIds.values()];
    for (const result of merged) {
      if (!keywordHitHasBody(result)) {
        // A uniform exact-only baseline lets temporal decay order otherwise
        // equivalent filename hits without reusing incomparable path BM25.
        result.score = result.exactPathSpecificity > 0 ? 1 : result.pathScore;
      }
    }
    return merged.toSorted(compareKeywordSearchHits);
  }

  private limitKeywordSearchHits(
    results: KeywordSearchHit[],
    nonExactLimit: number,
  ): KeywordSearchHit[] {
    const ranked = results.toSorted(compareKeywordSearchHits);
    const exactBody = ranked
      .filter((entry) => entry.exactPathSpecificity > 0 && keywordHitHasBody(entry))
      .slice(0, nonExactLimit);
    const exactPathOnly = ranked.filter(
      (entry) => entry.exactPathSpecificity > 0 && !keywordHitHasBody(entry),
    );
    const boundedExact = exactBody.concat(exactPathOnly).toSorted(compareKeywordSearchHits);
    const selectedPathKeys = new Set<string>();
    for (const entry of boundedExact) {
      selectedPathKeys.add(`${entry.source}:${entry.path}`);
      if (selectedPathKeys.size === EXACT_PATH_CANDIDATE_LIMIT) {
        break;
      }
    }
    const exact = boundedExact.filter((entry) =>
      selectedPathKeys.has(`${entry.source}:${entry.path}`),
    );
    const nonExact = ranked
      .filter((entry) => entry.exactPathSpecificity === 0)
      .slice(0, nonExactLimit);
    return exact.concat(nonExact);
  }

  protected toMemorySearchResults(results: KeywordSearchHit[]): MemoryRetrievalResult[] {
    return results.map(
      ({
        id: _id,
        pathScore: _pathScore,
        exactPathSpecificity: _exactPathSpecificity,
        hasBodyMatch: _hasBodyMatch,
        ...result
      }) => result,
    );
  }
}
