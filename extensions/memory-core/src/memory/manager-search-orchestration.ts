import { getAgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { classifyMemoryMultimodalPath } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createSubsystemLogger,
  resolveUserPath,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  readMemoryFile,
  MEMORY_INDEX_VECTOR_TABLE as VECTOR_TABLE,
  MEMORY_SEARCH_DEADLINE_CONTROL,
  type MemoryReadResult,
  type MemorySearchManager,
  type MemorySearchResult,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { WorkerTaskError } from "openclaw/plugin-sdk/process-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { uniqueValues } from "openclaw/plugin-sdk/string-coerce-runtime";
import { mergeHybridResults, selectHybridSearchResults } from "./hybrid.js";
import { runMemoryVectorFallback } from "./manager-cpu-worker-runtime.js";
import {
  createMemoryEmbeddingOperationError,
  isMemoryEmbeddingOperationError,
} from "./manager-embedding-errors.js";
import { acquireMemoryIndexReadGeneration } from "./manager-index-generation-lease.js";
import {
  MemoryKeywordRetrieval,
  type KeywordSearchHit,
  type MemoryRetrievalResult,
} from "./manager-keyword-retrieval.js";
import type { MemoryIndexIdentityState } from "./manager-reindex-state.js";
import type { MemoryRetrievalIndexState } from "./manager-retrieval-read.js";
import { runVectorKnnInSubprocess } from "./manager-search-knn-subprocess.js";
import { searchVector } from "./manager-search-vector.js";
import { prepareExactPathMatcher } from "./manager-search.js";
import type { MemoryKeywordWorkerResult } from "./manager-search.worker.js";
import { assertMemoryShadowIdentity, readMemoryShadowIdentity } from "./manager-shadow-task.js";
import { applyRetrievalRanking, prepareActiveProjectKeys } from "./project-ranking.js";
import { applyTemporalDecayToHybridResults } from "./temporal-decay.js";

const SNIPPET_MAX_CHARS = 700;
const SEARCH_CANDIDATE_UNIVERSE = 200;
const log = createSubsystemLogger("memory");
type MemoryIndexSearchOptions = NonNullable<Parameters<MemorySearchManager["search"]>[1]>;
type VectorSearchHit = MemoryRetrievalResult & { id: string };

export abstract class MemorySearchOrchestration extends MemoryKeywordRetrieval {
  private readonly sessionWarm = new Set<string>();

  protected claimSessionWarmSync(sessionKey?: string): boolean {
    if (!this.settings.sync.onSessionStart) {
      return false;
    }
    const key = sessionKey?.trim() || "";
    if (key && this.sessionWarm.has(key)) {
      return false;
    }
    if (key) {
      this.sessionWarm.add(key);
    }
    return this.dirty || this.sessionsDirty;
  }

  async search(query: string, opts?: MemoryIndexSearchOptions): Promise<MemorySearchResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }
    const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
    const minScore = opts?.minScore ?? this.settings.query.minScore;
    const hasActiveProject = (opts?.activeProjectKeys?.length ?? 0) > 0;
    // Rank one shared window before trimming small requests. Preserve the historical
    // project selection cap and caller-sized selection for ordinary requests above it.
    const candidateMaxResults = hasActiveProject
      ? SEARCH_CANDIDATE_UNIVERSE
      : Math.max(SEARCH_CANDIDATE_UNIVERSE, maxResults);
    // Retrieval owners apply project ranking and eligibility, including lexical recall.
    // Only cap the expanded window here so partial and final recall survive together.
    const selectResults = (results: MemoryRetrievalResult[]) =>
      results.slice(0, maxResults).map(({ sourceMtime: _sourceMtime, ...result }) => result);
    const results = await this.searchCandidates(normalizedQuery, {
      ...opts,
      maxResults: candidateMaxResults,
      minScore,
      onPartialResults: opts?.onPartialResults
        ? (partial) => opts.onPartialResults?.(partial && selectResults(partial))
        : undefined,
    });
    return selectResults(results);
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<MemoryReadResult> {
    // Session-only indexing is local, but explicit file reads still use the workspace owner.
    const access = this.memoryFiles
      ? undefined
      : getAgentWorkspaceAccess(this.workspaceDir, "memoryFiles");
    const files = this.memoryFiles ?? access?.memoryFiles;
    files?.assertCurrent();
    return await (files?.readFile ?? readMemoryFile)({
      workspaceDir: this.workspaceDir,
      extraPaths: this.settings.extraPaths,
      relPath: params.relPath,
      from: params.from,
      lines: params.lines,
    });
  }

  private async searchCandidates(
    normalizedQuery: string,
    opts?: MemoryIndexSearchOptions,
  ): Promise<MemoryRetrievalResult[]> {
    const minScore = opts?.minScore ?? this.settings.query.minScore;
    const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
    const searchSources =
      opts?.sources && opts.sources.length > 0
        ? uniqueValues(opts.sources).filter((source) => this.sources.has(source))
        : undefined;
    const sourceFilterAllowed = !opts?.sources?.length || (searchSources?.length ?? 0) > 0;
    // Trusted recall may request recall-only transcripts; ordinary searches use
    // the configured corpus. Both preparation and later probes share this filter.
    const sourceFilterList = searchSources ?? this.settings.searchSources;
    const hybrid = this.settings.query.hybrid;
    const candidates = Math.min(
      200,
      Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)),
    );
    const fuseRecallMetadata =
      (opts?.lexicalOnly === true || this.providerRequirement.mode === "fts-only") &&
      sourceFilterList.length === 1 &&
      sourceFilterList[0] === "sessions";
    const keywordOptions = { boostFallbackRanking: true, signal: opts?.signal, fuseRecallMetadata };
    const database = this.publishedDatabase;
    const databasePath = resolveUserPath(this.settings.store.databasePath);
    const fileIdentity = fuseRecallMetadata ? readMemoryShadowIdentity(databasePath) : undefined;
    const assertReadOwner = () => {
      opts?.signal?.throwIfAborted();
      if (database.closed || !database.db.isOpen || this.publishedDatabase !== database) {
        throw new Error("Memory retrieval changed its captured database owner");
      }
      if (fileIdentity) {
        assertMemoryShadowIdentity(databasePath, fileIdentity);
      }
    };
    let preparedKeyword: MemoryKeywordWorkerResult | undefined;
    let releaseGeneration: (() => Promise<void>) | undefined;
    const releaseReadGeneration = async () => {
      const release = releaseGeneration;
      releaseGeneration = undefined;
      preparedKeyword = undefined;
      await release?.();
    };
    const readIndexState = async () => {
      releaseGeneration ??= await acquireMemoryIndexReadGeneration(
        this.settings.store.databasePath,
        opts?.signal,
        fuseRecallMetadata,
      );
      assertReadOwner();
      preparedKeyword = undefined;
      if (
        sourceFilterAllowed &&
        this.fts.enabled &&
        this.fts.available &&
        (opts?.lexicalOnly ||
          hybrid.enabled ||
          this.providerRequirement.mode === "fts-only" ||
          (this.providerInitialized && !this.provider) ||
          this.embeddingBootstrapFailure !== undefined)
      ) {
        const prepared = await this.prepareKeywordSearch(
          normalizedQuery,
          candidates,
          keywordOptions,
          sourceFilterList,
        );
        preparedKeyword = prepared.keyword;
        return prepared.indexState;
      }
      return await this.readRetrievalIndexState(opts?.signal);
    };
    const runSearch = async () => {
      opts?.onDebug?.({ backend: "builtin" });
      if (this.providerRequirement.mode === "required") {
        await this.ensureProviderInitialized();
        this.assertRequiredProviderAvailable("search");
      }
      let indexState = await readIndexState();
      let hasIndexedContent = this.hasIndexedContent(indexState);
      if (!hasIndexedContent) {
        await releaseReadGeneration();
        try {
          // A fresh process can receive its first search before background watch/session
          // syncs have built the index. Await fresh source discovery, but let the
          // sync owner decide whether the index needs a full rebuild.
          await this.syncAdmitted(
            { reason: "search-bootstrap" },
            { allowEmbeddingBootstrapFallback: true },
          );
        } catch (err) {
          if (err instanceof WorkerTaskError && err.code === "overloaded") {
            throw err;
          }
          if (
            this.providerRequirement.mode === "optional" &&
            isMemoryEmbeddingOperationError(err)
          ) {
            const failedProvider = this.provider?.id ?? this.settings.provider;
            await this.retireCurrentProvider().catch((retireErr: unknown) => {
              const message = redactSensitiveText(formatErrorMessage(retireErr), {
                mode: "tools",
              });
              log.warn(`memory search-bootstrap: failed to retire embedding provider: ${message}`);
            });
            this.markEmbeddingBootstrapFailure(err, { provider: failedProvider });
            await this.syncAdmitted({ reason: "search-bootstrap" }).catch(
              (fallbackErr: unknown) => {
                if (fallbackErr instanceof WorkerTaskError && fallbackErr.code === "overloaded") {
                  throw fallbackErr;
                }
                const message = redactSensitiveText(formatErrorMessage(fallbackErr), {
                  mode: "tools",
                });
                log.warn(`memory sync failed (search-bootstrap-fallback): ${message}`);
              },
            );
          } else {
            log.warn(`memory sync failed (search-bootstrap): ${String(err)}`);
          }
        }
        indexState = await readIndexState();
        hasIndexedContent = this.hasIndexedContent(indexState);
      }
      if (!hasIndexedContent) {
        if (this.embeddingBootstrapFailure) {
          opts?.onDebug?.({
            backend: "builtin",
            embeddingBootstrap: this.embeddingBootstrapFailure,
          });
        }
        return [];
      }
      const recoveringEmbeddingProvider = this.embeddingBootstrapFailure !== undefined;
      if (recoveringEmbeddingProvider || (fuseRecallMetadata && !this.providerInitialized)) {
        await releaseReadGeneration();
      }
      const embeddingBootstrapKeywordOnly = await this.ensureEmbeddingProviderForSearch(
        indexState,
        opts?.onDebug,
      );
      const refreshSearchIdentity = () =>
        embeddingBootstrapKeywordOnly
          ? this.refreshKeywordFallbackIndexIdentity(indexState)
          : this.refreshIndexIdentityDirty({
              providerKeyKnown: this.providerInitialized,
              indexState,
            });
      if (recoveringEmbeddingProvider) {
        indexState = await readIndexState();
      }
      const sessionStartSync = this.claimSessionWarmSync(opts?.sessionKey);
      const searchSyncEnabled =
        (this.settings.sync.onSearch || sessionStartSync) &&
        (this.purpose === "default" || this.purpose === "cli");
      if (
        !embeddingBootstrapKeywordOnly &&
        !this.provider &&
        (this.providerLifecycle.mode === "pending" ||
          (this.providerLifecycle.mode === "degraded" &&
            this.providerLifecycle.providerId !== this.settings.provider))
      ) {
        // A failed fallback must yield ownership back to the configured primary.
        // Reinitialize it before identity validation; leaving the lifecycle pending
        // makes a valid existing index look mismatched and drops keyword results.
        this.resetProviderInitializationForRetry();
        if (fuseRecallMetadata) {
          await releaseReadGeneration();
        }
        await this.ensureProviderInitialized();
      }
      this.assertRequiredProviderAvailable("search");
      if (
        !embeddingBootstrapKeywordOnly &&
        !this.provider &&
        this.providerLifecycle.mode === "degraded"
      ) {
        if (fuseRecallMetadata) {
          await releaseReadGeneration();
        }
        const activatedFallback = await this.activateSearchFallback(this.providerLifecycle.reason);
        if (activatedFallback) {
          refreshSearchIdentity();
        }
      }
      const indexIdentity = refreshSearchIdentity();
      const shouldRepairIdentity =
        hasIndexedContent &&
        (indexIdentity.status === "missing" ||
          (searchSyncEnabled &&
            indexIdentity.status === "mismatched" &&
            indexIdentity.owner === "openclaw" &&
            indexIdentity.versionOrder === "older"));
      if (shouldRepairIdentity) {
        await releaseReadGeneration();
        this.recordAutomaticRebuild();
        // The writer rechecks identity under its lease; another manager may have repaired it.
        await this.syncAdmitted(
          { reason: "search" },
          { allowEmbeddingBootstrapFallback: true },
        ).catch((err: unknown) => {
          if (err instanceof WorkerTaskError && err.code === "overloaded") {
            throw err;
          }
          log.warn(`memory sync failed (search-identity-repair): ${formatErrorMessage(err)}`);
        });
        indexState = await readIndexState();
      }
      let repairedIndexIdentity = shouldRepairIdentity ? refreshSearchIdentity() : indexIdentity;
      if (
        repairedIndexIdentity.status === "mismatched" &&
        !embeddingBootstrapKeywordOnly &&
        (await this.adoptPublishedFallbackProviderIfMatched(indexState))
      ) {
        repairedIndexIdentity = refreshSearchIdentity();
      }
      // Format upgrades retain keyword rows only when the identity owner confirms
      // that every corpus constraint still matches; source/scope changes fail closed.
      const formatUpgradePendingKeywordOnly = (state: MemoryIndexIdentityState): boolean =>
        state.status === "mismatched" &&
        state.owner === "openclaw" &&
        state.versionOrder === "older" &&
        (state.chunkingVersionOnly === true || state.lexicalCompatible === true) &&
        this.fts.enabled &&
        this.fts.available;
      if (repairedIndexIdentity.status !== "valid") {
        if (!formatUpgradePendingKeywordOnly(repairedIndexIdentity)) {
          return [];
        }
        log.warn(
          "memory search: format upgrade rebuild is pending; serving the existing keyword index",
        );
      }
      // No watcher can observe later edits after kernel capacity exhaustion.
      // Record a fresh generation at the search boundary so detached maintenance
      // receives the fact instead of starting from a clean transient manager.
      if (this.memoryWatchCapacityDegraded || this.memoryWatchUnavailable) {
        this.dirty = true;
      }
      const capacitySyncInFlight =
        (this.memoryWatchCapacityDegraded || this.memoryWatchUnavailable) &&
        this.activeBackgroundSearchSyncs.size > 0;
      if (
        searchSyncEnabled &&
        !capacitySyncInFlight &&
        !formatUpgradePendingKeywordOnly(repairedIndexIdentity) &&
        (this.dirty || this.sessionsDirty)
      ) {
        const trackedSearchSync = this.syncPublishedIndexInBackground({ reason: "search" })
          .catch((err: unknown) => {
            log.warn(`memory sync failed (search): ${String(err)}`);
          })
          .finally(() => {
            this.activeBackgroundSearchSyncs.delete(trackedSearchSync);
          });
        this.activeBackgroundSearchSyncs.add(trackedSearchSync);
      }
      // Reuse the facts captured under this lease. Bootstrap and repair release
      // it before writing, then reread the published generation before continuing.
      let effectiveIdentity: MemoryIndexIdentityState = repairedIndexIdentity;
      for (let identityAttempt = 0; identityAttempt < 2; identityAttempt += 1) {
        if (!releaseGeneration) {
          indexState = await readIndexState();
        }
        const leasedIdentity = refreshSearchIdentity();
        effectiveIdentity = leasedIdentity;
        if (leasedIdentity.status === "valid" || formatUpgradePendingKeywordOnly(leasedIdentity)) {
          break;
        }
        await releaseReadGeneration();
        if (
          embeddingBootstrapKeywordOnly ||
          identityAttempt > 0 ||
          leasedIdentity.status !== "mismatched" ||
          !(await this.adoptPublishedFallbackProviderIfMatched(indexState))
        ) {
          return [];
        }
      }
      if (!sourceFilterAllowed) {
        return [];
      }
      const finalizeKeywords = (results: KeywordSearchHit[]) =>
        this.finalizeKeywordOnlyResults({
          results,
          temporalDecay: hybrid.temporalDecay,
          maxResults,
          minScore,
          activeProjectKeys: opts?.activeProjectKeys,
        });

      const keywordOnly =
        embeddingBootstrapKeywordOnly ||
        formatUpgradePendingKeywordOnly(effectiveIdentity) ||
        !this.provider ||
        opts?.lexicalOnly;
      if (formatUpgradePendingKeywordOnly(effectiveIdentity)) {
        opts?.onDebug?.({ backend: "builtin", effectiveMode: "keyword-only" });
      }
      const loadKeywordResults = async () => {
        const initialResult = preparedKeyword;
        preparedKeyword = undefined;
        const results =
          (keywordOnly || hybrid.enabled) && this.fts.enabled && this.fts.available
            ? await this.searchKeyword(
                normalizedQuery,
                candidates,
                keywordOptions,
                sourceFilterList,
                initialResult,
              ).catch((error: unknown) =>
                this.handleRetrievalError("FTS keyword", error, opts?.signal),
              )
            : [];
        if (!keywordOnly && opts?.onPartialResults) {
          const memoryResults = results.filter((entry) => entry.source === "memory");
          if (memoryResults.length > 0) {
            opts.onPartialResults(await finalizeKeywords(memoryResults));
          }
        }
        return results;
      };

      // Reply-path lexical recall skips query embedding and the semantic provider lease.
      if (keywordOnly || !this.provider) {
        this.assertRequiredProviderAvailable("search");
        if (!this.fts.enabled || !this.fts.available) {
          log.warn("memory search: keyword-only search has no available FTS index");
          return [];
        }
        return await finalizeKeywords(await loadKeywordResults());
      }
      let semanticProvider = this.provider;
      let vectorProviderIdentity: { model: string; aliases: string[] };
      let keywordResults: Awaited<ReturnType<typeof loadKeywordResults>> = [];
      let queryVec: number[];
      for (let fallbackAttempt = false; ; fallbackAttempt = true) {
        const semanticProviderRuntime = this.providerRuntime;
        vectorProviderIdentity = {
          model: semanticProvider.model,
          aliases: this.resolveProviderIndexIdentities()
            .slice(1)
            .map((identity) => identity.model),
        };
        const releaseProvider = this.acquireProviderUse(semanticProvider);
        try {
          keywordResults = await loadKeywordResults();
          try {
            queryVec = await this.embedQueryWithRetry(
              normalizedQuery,
              opts?.signal,
              semanticProvider,
              semanticProviderRuntime,
              opts?.[MEMORY_SEARCH_DEADLINE_CONTROL],
            );
            const dimensions = indexState.meta?.vectorDims;
            if (dimensions !== undefined && queryVec.length !== dimensions) {
              throw createMemoryEmbeddingOperationError({
                operation: "query",
                providerId: semanticProvider.id,
                cause: new Error(
                  `query embedding has ${queryVec.length} dimensions, but the memory index expects ${dimensions}; rebuild with openclaw memory index --force --agent ${this.agentId}`,
                ),
              });
            }
            break;
          } catch (err) {
            releaseProvider();
            // Cancellation leaves the provider healthy. A fallback failure is final;
            // only the first attempt can change provider and invalidate lexical recall.
            if (opts?.signal?.aborted) {
              throw err;
            }
            if (fallbackAttempt) {
              this.markLocalEmbeddingProviderDegraded(err);
              throw err;
            }
            opts?.onPartialResults?.(null);
            this.markLocalEmbeddingProviderDegraded(err);
            const message = formatErrorMessage(err);
            const activatedFallback =
              isMemoryEmbeddingOperationError(err) && (await this.activateSearchFallback(message));
            if (activatedFallback) {
              if (refreshSearchIdentity().status !== "valid" || !this.provider) {
                return [];
              }
              semanticProvider = this.provider;
            } else if (
              (!this.provider || this.providerRequirement.mode !== "required") &&
              this.fts.enabled &&
              this.fts.available
            ) {
              this.assertRequiredProviderAvailable("search");
              log.warn(
                `memory search: embeddings unavailable; using keyword-only results: ${message}`,
              );
              return await finalizeKeywords(keywordResults);
            } else {
              throw err;
            }
          }
        } finally {
          releaseProvider();
        }
      }
      const hasVector = queryVec.some((v) => v !== 0);
      const vector = hasVector
        ? await this.searchVector(
            queryVec,
            candidates,
            sourceFilterList,
            vectorProviderIdentity,
            indexState,
            keywordResults.map((entry) => entry.id),
            opts?.signal,
          ).catch((error: unknown) => ({
            results: this.handleRetrievalError("vector", error, opts?.signal),
            candidates: [],
          }))
        : { results: [], candidates: [] };
      const vectorResults = vector.results;

      if (!hybrid.enabled || !this.fts.enabled || !this.fts.available) {
        const activeProjects = prepareActiveProjectKeys(opts?.activeProjectKeys);
        const eligible = applyRetrievalRanking(vectorResults, activeProjects).filter(
          (entry) => entry.score >= minScore,
        );
        const decayed = await applyTemporalDecayToHybridResults({
          results: eligible,
          temporalDecay: hybrid.temporalDecay,
          workspaceDir: this.workspaceDir,
          sessionSourceMtimes: this.loadSourceMtimes("sessions", vectorResults),
          memorySourceMtimes: this.loadSourceMtimes("memory", vectorResults),
        });
        // Recency reorders eligible hits without changing their membership.
        return decayed
          .toSorted(
            (left, right) =>
              right.score - left.score ||
              left.path.localeCompare(right.path) ||
              left.startLine - right.startLine ||
              left.endLine - right.endLine,
          )
          .slice(0, maxResults);
      }

      const matchExactPath = prepareExactPathMatcher(normalizedQuery);
      const merged = await mergeHybridResults({
        vector: vectorResults.map((entry) => ({
          ...entry,
          vectorScore: entry.score,
          exactPathSpecificity: matchExactPath(entry.path),
        })),
        keyword: keywordResults.map((entry) => ({ ...entry, rankingScore: entry.score })),
        vectorWeight: hybrid.vectorWeight,
        textWeight: hybrid.textWeight,
        isNonTextMediaPath: (path) =>
          classifyMemoryMultimodalPath(path, this.settings.multimodal) !== null,
        mmr: hybrid.mmr,
        temporalDecay: hybrid.temporalDecay,
        activeProjectKeys: opts?.activeProjectKeys,
        workspaceDir: this.workspaceDir,
        // Vector enrichment runs last, so its facts win for paths in both sets.
        sessionSourceMtimes: this.loadSourceMtimes("sessions", [
          ...keywordResults,
          ...vectorResults,
        ]),
        memorySourceMtimes: this.loadSourceMtimes("memory", [...keywordResults, ...vectorResults]),
      });
      return selectHybridSearchResults({
        merged,
        keyword: keywordResults,
        vectorCandidates: vector.candidates,
        maxResults,
        minScore,
      });
    };
    return await this.withManagerOperation(async () => {
      try {
        const results = await runSearch();
        assertReadOwner();
        return results;
      } finally {
        await releaseReadGeneration();
      }
    });
  }

  private async activateSearchFallback(reason: string): Promise<boolean> {
    return await this.activateFallbackProvider(reason).catch((error: unknown) => {
      log.warn(`memory search: failed to activate fallback provider: ${formatErrorMessage(error)}`);
      return false;
    });
  }

  private hasIndexedContent(state: MemoryRetrievalIndexState): boolean {
    return (
      state.hasIndexedChunks || (this.fts.enabled && this.fts.available && state.hasFtsContent)
    );
  }

  private handleRetrievalError(
    kind: "FTS keyword" | "vector",
    error: unknown,
    signal?: AbortSignal,
  ): [] {
    signal?.throwIfAborted();
    if (error instanceof WorkerTaskError && error.code === "overloaded") {
      throw error;
    }
    log.warn(`memory search: ${kind} query failed: ${formatErrorMessage(error)}`);
    return [];
  }

  private async searchVector(
    queryVec: number[],
    limit: number,
    sourceFilterList: MemorySource[],
    providerIdentity: { model: string; aliases: string[] },
    indexState: MemoryRetrievalIndexState,
    keywordCandidateIds: string[],
    signal?: AbortSignal,
  ): Promise<{ results: VectorSearchHit[]; candidates: VectorSearchHit[] }> {
    const query = {
      providerModel: providerIdentity.model,
      providerModelAliases: providerIdentity.aliases,
      queryVec,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
    };
    const readVectorRows = (candidateIds?: string[]) =>
      runMemoryVectorFallback(
        { agentId: this.agentId, databasePath: resolveUserPath(this.settings.store.databasePath) },
        {
          ...query,
          candidateIds,
          limit: candidateIds?.length ?? limit,
          sourceFilter: this.buildSourceFilter(undefined, sourceFilterList),
        },
        signal,
      );
    const results = await searchVector({
      vectorTable: VECTOR_TABLE,
      ...query,
      signal,
      ensureVectorReady: async () => {
        if (!this.vector.enabled) {
          return false;
        }
        if (
          indexState.vectorState.state === "incomplete" ||
          indexState.vectorState.state === "unverified"
        ) {
          this.markConfiguredSourcesForFullReindex();
          return false;
        }
        return indexState.vectorState.state === "complete";
      },
      runFallback: readVectorRows,
      runVectorKnn: async (request, knnSignal) => {
        const response = await runVectorKnnInSubprocess({
          databasePath: resolveUserPath(this.settings.store.databasePath),
          extensionPath: this.vector.extensionPath,
          request,
          signal: knnSignal,
        });
        if (!response.fallbackScanRequired) {
          this.vector.available = true;
          this.vector.semanticAvailable = true;
          this.vector.dims = queryVec.length;
          this.vector.loadError = undefined;
        }
        return response;
      },
      sourceFilterVec: this.buildSourceFilter("c", sourceFilterList),
    });
    // Keyword candidates outside the vector window still need their stored
    // similarity; treating an unqueried vector as zero loses rare-term answers.
    const candidates = [...results];
    const scoredIds = new Set(candidates.map((entry) => entry.id));
    const missingIds = keywordCandidateIds.filter((id) => !scoredIds.has(id));
    if (missingIds.length > 0) {
      results.push(
        ...(await readVectorRows(missingIds).catch((error: unknown) =>
          this.handleRetrievalError("vector", error, signal),
        )),
      );
    }
    return { results: await this.attachRecallMetadata(results, signal), candidates };
  }
}
