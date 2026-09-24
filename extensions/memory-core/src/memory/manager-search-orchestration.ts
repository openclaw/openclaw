import { getAgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { classifyMemoryMultimodalPath } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createSubsystemLogger,
  resolveUserPath,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  readMemoryFile,
  MEMORY_INDEX_VECTOR_TABLE,
  MEMORY_SEARCH_DEADLINE_CONTROL,
  type MemoryReadResult,
  type MemorySearchManager,
  type MemorySearchResult,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { WorkerTaskError } from "openclaw/plugin-sdk/process-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { uniqueValues } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  mergeHybridResults,
  selectHybridSearchResults,
  type HybridSearchResult,
} from "./hybrid.js";
import { applyImportanceMultiplier } from "./importance.js";
import { runMemoryVectorFallback } from "./manager-cpu-worker-runtime.js";
import { projectHybridCandidates } from "./manager-hybrid-candidates.js";
import { acquireMemoryIndexReadGeneration } from "./manager-index-generation-lease.js";
import {
  MemoryKeywordRetrieval,
  type KeywordSearchHit,
  type MemoryRetrievalResult,
} from "./manager-keyword-retrieval.js";
import type { MemoryIndexIdentityState } from "./manager-reindex-state.js";
import type { MemoryRetrievalIndexState } from "./manager-retrieval-read.js";
import { runVectorKnnInSubprocess } from "./manager-search-knn-subprocess.js";
import { resolveMemorySearchPreflight } from "./manager-search-preflight.js";
import { searchVector } from "./manager-search-vector.js";
import type { MemoryKeywordWorkerResult } from "./manager-search.worker.js";
import { applyProjectRanking, prepareActiveProjectKeys } from "./project-ranking.js";
import { applyTemporalDecayToHybridResults } from "./temporal-decay.js";

const SNIPPET_MAX_CHARS = 700;
const SEARCH_CANDIDATE_UNIVERSE = 200;
const VECTOR_TABLE = MEMORY_INDEX_VECTOR_TABLE;
const log = createSubsystemLogger("memory");
type MemoryIndexSearchOptions = NonNullable<Parameters<MemorySearchManager["search"]>[1]>;

export abstract class MemorySearchOrchestration extends MemoryKeywordRetrieval {
  protected abstract sessionWarm: Set<string>;

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
    const keywordOptions = { boostFallbackRanking: true, signal: opts?.signal };
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
      );
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
          if (this.providerRequirement.mode === "optional" && this.shouldFallbackOnError(err)) {
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
      const preflight = resolveMemorySearchPreflight({
        query: normalizedQuery,
        hasIndexedContent,
      });
      if (!preflight.shouldSearch) {
        if (this.embeddingBootstrapFailure) {
          opts?.onDebug?.({
            backend: "builtin",
            embeddingBootstrap: this.embeddingBootstrapFailure,
          });
        }
        return [];
      }
      const cleaned = preflight.normalizedQuery;
      const recoveringEmbeddingProvider = this.embeddingBootstrapFailure !== undefined;
      if (recoveringEmbeddingProvider) {
        await releaseReadGeneration();
      }
      const embeddingBootstrapKeywordOnly = await this.ensureEmbeddingProviderForSearch(
        indexState,
        opts?.onDebug,
      );
      if (recoveringEmbeddingProvider) {
        indexState = await readIndexState();
      }
      const sessionStartSync = this.claimSessionWarmSync(opts?.sessionKey);
      const searchSyncEnabled =
        (this.settings.sync.onSearch || sessionStartSync) &&
        (this.purpose === "default" || this.purpose === "cli");
      if (
        !embeddingBootstrapKeywordOnly &&
        preflight.shouldInitializeProvider &&
        !this.provider &&
        (this.providerLifecycle.mode === "pending" ||
          (this.providerLifecycle.mode === "degraded" &&
            this.providerLifecycle.providerId !== this.settings.provider))
      ) {
        // A failed fallback must yield ownership back to the configured primary.
        // Reinitialize it before identity validation; leaving the lifecycle pending
        // makes a valid existing index look mismatched and drops keyword results.
        this.resetProviderInitializationForRetry();
        await this.ensureProviderInitialized();
      }
      this.assertRequiredProviderAvailable("search");
      if (
        !embeddingBootstrapKeywordOnly &&
        !this.provider &&
        this.providerLifecycle.mode === "degraded"
      ) {
        const activatedFallback = await this.activateFallbackProvider(
          this.providerLifecycle.reason,
        ).catch((fallbackErr: unknown) => {
          log.warn(
            `memory search: failed to activate fallback provider: ${formatErrorMessage(fallbackErr)}`,
          );
          return false;
        });
        if (activatedFallback) {
          this.refreshIndexIdentityDirty({
            providerKeyKnown: this.providerInitialized,
            indexState,
          });
        }
      }
      const indexIdentity = embeddingBootstrapKeywordOnly
        ? this.refreshKeywordFallbackIndexIdentity(indexState)
        : this.refreshIndexIdentityDirty({
            providerKeyKnown: this.providerInitialized,
            indexState,
          });
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
      let repairedIndexIdentity = shouldRepairIdentity
        ? embeddingBootstrapKeywordOnly
          ? this.refreshKeywordFallbackIndexIdentity(indexState)
          : this.refreshIndexIdentityDirty({
              providerKeyKnown: this.providerInitialized,
              indexState,
            })
        : indexIdentity;
      if (
        repairedIndexIdentity.status === "mismatched" &&
        !embeddingBootstrapKeywordOnly &&
        (await this.adoptPublishedFallbackProviderIfMatched(indexState))
      ) {
        repairedIndexIdentity = this.refreshIndexIdentityDirty({
          providerKeyKnown: this.providerInitialized,
          indexState,
        });
      }
      // A pending OpenClaw chunking upgrade keeps the stored keyword rows
      // readable: the resolver only marks chunkingVersionOnly when every
      // corpus constraint still matches, so source or scope changes
      // still fail closed here.
      const chunkingUpgradePendingKeywordOnly = (state: MemoryIndexIdentityState): boolean =>
        state.status === "mismatched" &&
        state.owner === "openclaw" &&
        state.code === "chunking_version" &&
        state.versionOrder === "older" &&
        state.chunkingVersionOnly === true &&
        this.fts.enabled &&
        this.fts.available;
      if (repairedIndexIdentity.status !== "valid") {
        if (!chunkingUpgradePendingKeywordOnly(repairedIndexIdentity)) {
          return [];
        }
        log.warn(
          "memory search: chunking upgrade rebuild is pending; serving the existing keyword index",
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
        !chunkingUpgradePendingKeywordOnly(repairedIndexIdentity) &&
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
        const leasedIdentity = embeddingBootstrapKeywordOnly
          ? this.refreshKeywordFallbackIndexIdentity(indexState)
          : this.refreshIndexIdentityDirty({
              providerKeyKnown: this.providerInitialized,
              indexState,
            });
        effectiveIdentity = leasedIdentity;
        if (
          leasedIdentity.status === "valid" ||
          chunkingUpgradePendingKeywordOnly(leasedIdentity)
        ) {
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
        chunkingUpgradePendingKeywordOnly(effectiveIdentity) ||
        !this.provider ||
        opts?.lexicalOnly;
      if (chunkingUpgradePendingKeywordOnly(effectiveIdentity)) {
        opts?.onDebug?.({ backend: "builtin", effectiveMode: "keyword-only" });
      }
      const loadKeywordResults = async () => {
        const initialResult = preparedKeyword;
        preparedKeyword = undefined;
        const results =
          (keywordOnly || hybrid.enabled) && this.fts.enabled && this.fts.available
            ? await this.searchKeywordWithFallback(
                cleaned,
                candidates,
                keywordOptions,
                sourceFilterList,
                initialResult,
              ).catch((err: unknown) => {
                opts?.signal?.throwIfAborted();
                if (err instanceof WorkerTaskError && err.code === "overloaded") {
                  throw err;
                }
                log.warn(`memory search: FTS keyword query failed: ${formatErrorMessage(err)}`);
                return [];
              })
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
      let semanticProviderRuntime = this.providerRuntime;
      let vectorProviderIdentity = {
        model: semanticProvider.model,
        aliases: this.resolveProviderIndexIdentities()
          .slice(1)
          .map((identity) => identity.model),
      };

      let keywordResults: Awaited<ReturnType<typeof loadKeywordResults>> = [];
      let queryVec: number[];
      const releaseSemanticProvider = this.acquireProviderUse(semanticProvider);
      try {
        keywordResults = await loadKeywordResults();
        try {
          queryVec = await this.embedQueryWithRetry(
            cleaned,
            opts?.signal,
            semanticProvider,
            false,
            semanticProviderRuntime,
            opts?.[MEMORY_SEARCH_DEADLINE_CONTROL],
          );
        } catch (err) {
          releaseSemanticProvider();
          // An aborted caller already stopped waiting; keep the provider generation
          // healthy and skip fallback activation instead of poisoning later searches.
          if (opts?.signal?.aborted) {
            throw err;
          }
          // A provider transition can change index identity; never retain candidates
          // from the previous generation while fallback activation is pending.
          opts?.onPartialResults?.(null);
          this.markLocalEmbeddingProviderDegraded(err);
          const message = formatErrorMessage(err);
          const activatedFallback = this.shouldFallbackOnError(err)
            ? await this.activateFallbackProvider(message).catch((fallbackErr: unknown) => {
                log.warn(
                  `memory search: failed to activate fallback provider: ${formatErrorMessage(fallbackErr)}`,
                );
                return false;
              })
            : false;
          if (activatedFallback) {
            if (
              this.refreshIndexIdentityDirty({
                providerKeyKnown: this.providerInitialized,
                indexState,
              }).status !== "valid"
            ) {
              return [];
            }
            if (!this.provider) {
              return [];
            }
            semanticProvider = this.provider;
            semanticProviderRuntime = this.providerRuntime;
            vectorProviderIdentity = {
              model: semanticProvider.model,
              aliases: this.resolveProviderIndexIdentities()
                .slice(1)
                .map((identity) => identity.model),
            };
            const releaseFallbackProvider = this.acquireProviderUse(semanticProvider);
            try {
              keywordResults = await loadKeywordResults();
              try {
                queryVec = await this.embedQueryWithRetry(
                  cleaned,
                  opts?.signal,
                  semanticProvider,
                  false,
                  semanticProviderRuntime,
                  opts?.[MEMORY_SEARCH_DEADLINE_CONTROL],
                );
              } catch (fallbackErr) {
                releaseFallbackProvider();
                if (!opts?.signal?.aborted) {
                  this.markLocalEmbeddingProviderDegraded(fallbackErr);
                }
                throw fallbackErr;
              }
            } finally {
              releaseFallbackProvider();
            }
          } else if (!this.provider && this.fts.enabled && this.fts.available) {
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
        releaseSemanticProvider();
      }
      const hasVector = queryVec.some((v) => v !== 0);
      const vectorResults = hasVector
        ? await this.searchVector(
            queryVec,
            candidates,
            sourceFilterList,
            vectorProviderIdentity,
            indexState,
            opts?.signal,
          ).catch((err: unknown) => {
            opts?.signal?.throwIfAborted();
            if (err instanceof WorkerTaskError && err.code === "overloaded") {
              throw err;
            }
            log.warn(`memory search: vector query failed: ${formatErrorMessage(err)}`);
            return [];
          })
        : [];

      if (!hybrid.enabled || !this.fts.enabled || !this.fts.available) {
        const decayed = await applyTemporalDecayToHybridResults({
          results: vectorResults,
          temporalDecay: hybrid.temporalDecay,
          workspaceDir: this.workspaceDir,
          sessionSourceMtimes: this.loadSourceMtimes("sessions", vectorResults),
          memorySourceMtimes: this.loadSourceMtimes("memory", vectorResults),
        });
        // Decay and importance can reverse the order returned by vector retrieval.
        const activeProjects = prepareActiveProjectKeys(opts?.activeProjectKeys);
        return applyProjectRanking(applyImportanceMultiplier(decayed), activeProjects)
          .filter((entry) => entry.score >= minScore)
          .toSorted(
            (left, right) =>
              right.score - left.score ||
              left.path.localeCompare(right.path) ||
              left.startLine - right.startLine ||
              left.endLine - right.endLine,
          )
          .slice(0, maxResults);
      }

      const merged = await this.mergeHybridResults({
        query: cleaned,
        vector: vectorResults,
        keyword: keywordResults,
        vectorWeight: hybrid.vectorWeight,
        textWeight: hybrid.textWeight,
        mmr: hybrid.mmr,
        temporalDecay: hybrid.temporalDecay,
        activeProjectKeys: opts?.activeProjectKeys,
      });
      return selectHybridSearchResults({
        merged,
        keyword: keywordResults,
        maxResults,
        minScore,
      });
    };
    return await this.withManagerOperation(async () => {
      try {
        return await runSearch();
      } finally {
        await releaseReadGeneration();
      }
    });
  }

  private hasIndexedContent(state: MemoryRetrievalIndexState): boolean {
    return (
      state.hasIndexedChunks || (this.fts.enabled && this.fts.available && state.hasFtsContent)
    );
  }

  private async searchVector(
    queryVec: number[],
    limit: number,
    sourceFilterList: MemorySource[],
    providerIdentity: { model: string; aliases: string[] },
    indexState: MemoryRetrievalIndexState,
    signal?: AbortSignal,
  ): Promise<Array<MemoryRetrievalResult & { id: string }>> {
    const results = await searchVector({
      vectorTable: VECTOR_TABLE,
      providerModel: providerIdentity.model,
      providerModelAliases: providerIdentity.aliases,
      queryVec,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      signal,
      ensureVectorReady: async (dimensions) => {
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
        return (
          indexState.vectorState.state === "complete" &&
          (indexState.meta?.vectorDims === undefined || indexState.meta.vectorDims === dimensions)
        );
      },
      runFallback: () =>
        runMemoryVectorFallback(
          {
            agentId: this.agentId,
            databasePath: resolveUserPath(this.settings.store.databasePath),
          },
          {
            providerModel: providerIdentity.model,
            providerModelAliases: providerIdentity.aliases,
            queryVec,
            limit,
            snippetMaxChars: SNIPPET_MAX_CHARS,
            sourceFilter: this.buildSourceFilter(undefined, sourceFilterList),
          },
          signal,
        ),
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
    return this.attachRecallMetadata(results, signal, sourceFilterList);
  }

  private mergeHybridResults(params: {
    query: string;
    vector: Array<MemoryRetrievalResult & { id: string }>;
    keyword: KeywordSearchHit[];
    vectorWeight: number;
    textWeight: number;
    mmr?: { enabled: boolean; lambda: number };
    temporalDecay?: { enabled: boolean; halfLifeDays: number };
    activeProjectKeys?: readonly string[];
  }): Promise<HybridSearchResult<MemorySource>[]> {
    return mergeHybridResults({
      ...projectHybridCandidates(params.query, params.vector, params.keyword),
      vectorWeight: params.vectorWeight,
      textWeight: params.textWeight,
      isNonTextMediaPath: (path) =>
        classifyMemoryMultimodalPath(path, this.settings.multimodal) !== null,
      mmr: params.mmr,
      temporalDecay: params.temporalDecay,
      activeProjectKeys: params.activeProjectKeys,
      workspaceDir: this.workspaceDir,
      // Vector enrichment runs last, so its facts win when a path occurs in both sets.
      sessionSourceMtimes: this.loadSourceMtimes("sessions", [...params.keyword, ...params.vector]),
      memorySourceMtimes: this.loadSourceMtimes("memory", [...params.keyword, ...params.vector]),
    });
  }
}
