import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createSubsystemLogger,
  resolveUserPath,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  MEMORY_INDEX_FTS_TABLE as FTS_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE as PATH_FTS_TABLE,
  type MemorySearchResult,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { scoreExactPathTieForTemporalDecay } from "./hybrid.js";
import {
  runMemoryCuratedCandidates,
  runMemoryKeywordSearch,
  runMemoryRecallMetadata,
} from "./manager-cpu-worker-runtime.js";
import { MemoryProviderLifecycle } from "./manager-provider-lifecycle.js";
import type { MemoryRecallData } from "./manager-retrieval-read.js";
import { prepareExactPathMatcher, type ExactPathSpecificity } from "./manager-search.js";
import type {
  MemoryKeywordWorkerQuery,
  MemoryKeywordWorkerResult,
} from "./manager-search.worker.js";
import {
  applyRetrievalRanking,
  prepareActiveProjectKeys,
  projectScoreMultiplier,
} from "./project-ranking.js";
import { applyTemporalDecayToHybridResults } from "./temporal-decay.js";

const SNIPPET_MAX_CHARS = 700;
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
  fuseRecallMetadata?: boolean;
};

function projectRecallMetadata(
  row:
    | { importance: number | null; triggers: string | null; project_key: string | null }
    | undefined,
) {
  return {
    ...(typeof row?.importance === "number" ? { importance: row.importance } : {}),
    ...(typeof row?.triggers === "string" && row.triggers.trim()
      ? { triggers: row.triggers.trim() }
      : {}),
    ...(typeof row?.project_key === "string" && row.project_key.trim()
      ? { projectKey: row.project_key.trim() }
      : {}),
  };
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
    const bodyPresenceDelta = Number(b.hasBodyMatch) - Number(a.hasBodyMatch);
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
  async listTriggerCandidates(opts?: {
    limit?: number;
    activeProjectKeys?: string[];
  }): Promise<MemorySearchResult[]> {
    return await this.readCuratedMemoryCandidates(opts, false);
  }

  async listCuratedProjectCandidates(opts: {
    activeProjectKeys: string[];
    limit?: number;
  }): Promise<MemorySearchResult[]> {
    return await this.readCuratedMemoryCandidates(opts, true);
  }

  private async readCuratedMemoryCandidates(
    opts: { limit?: number; activeProjectKeys?: string[] } | undefined,
    projectsOnly: boolean,
  ): Promise<MemorySearchResult[]> {
    const limit = Math.max(1, Math.min(512, Math.floor(opts?.limit ?? (projectsOnly ? 48 : 512))));
    return await this.withManagerOperation(async () => {
      const result = await runMemoryCuratedCandidates(
        {
          agentId: this.agentId,
          databasePath: resolveUserPath(this.settings.store.databasePath),
        },
        {
          limit,
          projectsOnly,
          activeProjectKeys: opts?.activeProjectKeys,
          checkProvenanceRepair: this.memorySourceProvenanceRepairPending,
        },
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
      return result.rows.map((row): MemorySearchResult => {
        const candidate: MemorySearchResult = {
          path: row.path,
          startLine: row.start_line,
          endLine: row.end_line,
          score: 0,
          snippet: row.text,
          source: "memory",
        };
        Object.assign(candidate, projectRecallMetadata(row));
        candidate.provenance = {
          originClass: row.origin_class,
          sessionKind: row.session_kind,
          observedAt: row.observed_at,
        };
        if (typeof row.supersedes_key === "string") {
          candidate.provenance.supersedesKey = row.supersedes_key;
        }
        return candidate;
      });
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
          const contentScore = entry.hasBodyMatch ? entry.score : 0;
          return { ...entry, score: scoreExactPathTieForTemporalDecay(contentScore) };
        })
      : params.results;
    const decayed = await applyTemporalDecayToHybridResults({
      results: decayInputs,
      temporalDecay: params.temporalDecay,
      workspaceDir: this.workspaceDir,
      sessionSourceMtimes: this.loadSourceMtimes("sessions", params.results),
      memorySourceMtimes: this.loadSourceMtimes("memory", params.results),
    });
    // Preserve specificity and adjusted body relevance before normalizing exact public scores.
    const activeProjects = prepareActiveProjectKeys(params.activeProjectKeys);
    const ranked = applyRetrievalRanking(decayed, activeProjects)
      .toSorted((left, right) => compareKeywordSearchHits(left, right, !appliesTemporalDecay))
      .map((entry) =>
        entry.exactPathSpecificity > 0
          ? Object.assign(entry, {
              score: projectScoreMultiplier(entry.projectKey, activeProjects),
            })
          : entry,
      );
    const strict = ranked.filter((entry) => entry.score >= params.minScore);
    const selected = strict.length > 0 ? strict : ranked.filter((entry) => entry.score >= 0);
    return this.toMemorySearchResults(selected.slice(0, params.maxResults));
  }

  protected loadSourceMtimes(
    source: MemorySource,
    results: ReadonlyArray<Pick<MemoryRetrievalResult, "path" | "source" | "sourceMtime">>,
  ): ReadonlyMap<string, number | undefined> | undefined {
    if (source === "memory" && !this.memoryFiles) {
      return undefined;
    }
    const entries = results.filter((entry) => entry.source === source);
    if (entries.length === 0) {
      return undefined;
    }
    return new Map(entries.map((entry) => [entry.path, entry.sourceMtime]));
  }

  protected async attachRecallMetadata<T extends MemoryRetrievalResult & { id: string }>(
    results: T[],
    signal?: AbortSignal,
  ): Promise<T[]> {
    if (results.length === 0) {
      return results;
    }
    const query = {
      candidates: results.map(({ id, path, source }) => ({ id, path, source })),
      includeMemoryMtimes: Boolean(this.memoryFiles),
    };
    const metadata = await runMemoryRecallMetadata(
      {
        agentId: this.agentId,
        databasePath: resolveUserPath(this.settings.store.databasePath),
      },
      query,
      signal,
    );
    return this.applyRecallMetadata(results, metadata);
  }

  private applyRecallMetadata<T extends MemoryRetrievalResult & { id: string }>(
    results: T[],
    { rows: metadataById, sourceMtimes }: MemoryRecallData,
  ): T[] {
    // The left-joined metadata reader omits only missing chunks. A forget may
    // delete one while the worker is reading its earlier snapshot.
    return results
      .filter((entry) => metadataById.has(entry.id))
      .map((entry) => {
        const row = metadataById.get(entry.id);
        return Object.assign(entry, {
          sourceMtime: sourceMtimes[entry.source].get(entry.path),
          ...projectRecallMetadata(row),
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
      includeRecallMetadata: options?.fuseRecallMetadata,
      body: {
        ftsTable: FTS_TABLE,
        query,
        ftsTokenizer: this.settings.store.fts.tokenizer,
        limit,
        snippetMaxChars: SNIPPET_MAX_CHARS,
        sourceFilter: this.buildSourceFilter(undefined, sourceFilterList),
        boostFallbackRanking: options?.boostFallbackRanking,
      },
      path: {
        pathFtsTable: PATH_FTS_TABLE,
        query,
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
    const results = this.limitKeywordSearchHits(merged, limit);
    return result.recallData ? this.applyRecallMetadata(results, result.recallData) : results;
  }

  protected async searchKeyword(
    query: string,
    limit: number,
    options: KeywordSearchOptions | undefined,
    sourceFilterList: MemorySource[],
    initialResult?: MemoryKeywordWorkerResult,
  ): Promise<KeywordSearchHit[]> {
    if (!this.fts.enabled || !this.fts.available) {
      return [];
    }
    const result =
      initialResult ??
      (await runMemoryKeywordSearch(
        { agentId: this.agentId, databasePath: resolveUserPath(this.settings.store.databasePath) },
        this.buildKeywordSearchQuery(query, limit, options, sourceFilterList),
        options?.signal,
      ));
    options?.signal?.throwIfAborted();
    const results = this.resolveKeywordSearchResult(result, query, limit);
    // Fused reads already observed metadata in the admitted generation.
    return options?.fuseRecallMetadata
      ? results
      : this.attachRecallMetadata(results, options?.signal);
  }

  private mergeKeywordSearchHits(
    resultSets: Omit<KeywordSearchHit, "exactPathSpecificity">[][],
    exactPathQuery: string,
  ): KeywordSearchHit[] {
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
        const existingHasBody = existing.hasBodyMatch;
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
      if (!result.hasBodyMatch) {
        // A uniform exact-only baseline lets temporal decay order otherwise
        // equivalent filename hits without reusing incomparable path BM25.
        result.score = result.exactPathSpecificity > 0 ? 1 : result.pathScore;
      }
    }
    return merged;
  }

  private limitKeywordSearchHits(
    results: KeywordSearchHit[],
    nonExactLimit: number,
  ): KeywordSearchHit[] {
    const ranked = results.toSorted(compareKeywordSearchHits);
    const exactBody = ranked
      .filter((entry) => entry.exactPathSpecificity > 0 && entry.hasBodyMatch)
      .slice(0, nonExactLimit);
    const exactPathOnly = ranked.filter(
      (entry) => entry.exactPathSpecificity > 0 && !entry.hasBodyMatch,
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
        path,
        startLine,
        endLine,
        score,
        textScore,
        snippet,
        source,
        ...metadata
      }) =>
        Object.assign({ path, startLine, endLine, score, textScore, snippet, source }, metadata),
    );
  }
}
