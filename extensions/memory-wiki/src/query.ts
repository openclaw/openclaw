import path from "node:path";
import { resolveSessionAgentIdStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import { resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawConfig } from "../api.js";
import { loadMemoryWikiCompiledCache } from "./compiled-cache.js";
import type { ResolvedMemoryWikiConfig, WikiSearchBackend, WikiSearchCorpus } from "./config.js";
import { WIKI_PAGE_GROUPS } from "./markdown.js";
import {
  isMemoryReferenceLookup,
  parseMemoryReferenceLookup,
  resolveActiveMemoryAgentId,
  usesNativeMemoryProvider,
} from "./query-memory-provider.js";
import {
  normalizeLookupKey,
  readWikiPagesTask,
  type WikiPageReadTask,
  type WikiPageVisibility,
} from "./query-pages.js";
import { readMemoryWikiPages } from "./query-reader.js";
import {
  buildDigestCandidatePaths,
  buildWikiResultMetadata,
  type QueryableWikiPage,
  sortWikiSearchResults,
  type WikiResultMetadata,
  type WikiResultSource,
  type WikiSearchMode,
  type WikiSearchResult,
} from "./query-scoring.js";
import {
  readSharedMemoryPage,
  searchSharedMemory,
  shouldEnforceSessionVisibility,
  type SharedMemorySearchParams,
} from "./query-shared-memory.js";
import { initializeMemoryWikiVault } from "./vault.js";

type WikiGetResult = WikiResultMetadata & {
  content: string;
  fromLine: number;
  lineCount: number;
  totalLines?: number;
  truncated?: boolean;
} & WikiResultSource;

type QuerySearchOverrides = {
  searchBackend?: WikiSearchBackend;
  searchCorpus?: WikiSearchCorpus;
};

type WikiQueryParams = Omit<SharedMemorySearchParams, "query"> &
  QuerySearchOverrides & {
    config: ResolvedMemoryWikiConfig;
  };

function mergeWikiSearchCorpusResults(params: {
  wikiResults: WikiSearchResult[];
  memoryResults: WikiSearchResult[];
  maxResults: number;
  balanceCorpora: boolean;
}): WikiSearchResult[] {
  const wikiResults = sortWikiSearchResults(params.wikiResults);
  const memoryResults = sortWikiSearchResults(params.memoryResults);
  if (!params.balanceCorpora || wikiResults.length === 0 || memoryResults.length === 0) {
    return sortWikiSearchResults([...wikiResults, ...memoryResults]).slice(0, params.maxResults);
  }

  const perCorpusCap = Math.ceil(params.maxResults / 2);
  const selectedWiki = wikiResults.slice(0, perCorpusCap);
  const selectedMemory = memoryResults.slice(0, perCorpusCap);
  const selected = [...selectedWiki, ...selectedMemory];
  if (selected.length < params.maxResults) {
    selected.push(
      ...sortWikiSearchResults([
        ...wikiResults.slice(selectedWiki.length),
        ...memoryResults.slice(selectedMemory.length),
      ]).slice(0, params.maxResults - selected.length),
    );
  }

  return sortWikiSearchResults(selected).slice(0, params.maxResults);
}

function resolveExactWikiPagePath(lookup: string): string | null {
  const normalized = normalizeLookupKey(lookup);
  const segments = normalized.split("/");
  const [directory, ...pageSegments] = segments;
  if (
    !WIKI_PAGE_GROUPS.some(({ dir }) => dir === directory) ||
    pageSegments.length === 0 ||
    pageSegments.some((segment) => !segment || segment === "." || segment === "..") ||
    !normalized.endsWith(".md") ||
    path.posix.basename(normalized) === "index.md"
  ) {
    return null;
  }
  return normalized;
}

function resolveWikiPageVisibility(params: {
  appConfig?: OpenClawConfig;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
}): WikiPageVisibility | null {
  if (params.sandboxed !== true) {
    return null;
  }
  const sessionKey = params.agentSessionKey?.trim();
  const scopedAgentId = normalizeLowercaseStringOrEmpty(
    params.agentId?.trim() ||
      (params.appConfig && sessionKey
        ? resolveSessionAgentIdStrict({ sessionKey, config: params.appConfig })
        : undefined),
  );
  return { scopedAgentId };
}

function shouldUseSharedMemory(config: ResolvedMemoryWikiConfig): boolean {
  return (
    config.search.backend === "shared" &&
    (config.search.corpus === "memory" || config.search.corpus === "all")
  );
}

function assertSessionVisibilityAppConfig(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  operation: string;
}): void {
  if (
    shouldUseSharedMemory(params.config) &&
    shouldEnforceSessionVisibility(params) &&
    !params.appConfig
  ) {
    throw new Error(
      `${params.operation} requires appConfig to enforce session visibility for session-bound shared memory calls.`,
    );
  }
}

function shouldSearchWiki(config: ResolvedMemoryWikiConfig): boolean {
  return config.search.corpus === "wiki" || config.search.corpus === "all";
}

function shouldSearchSharedMemory(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
): boolean {
  return shouldUseSharedMemory(config) && appConfig !== undefined;
}

function applySearchOverrides(
  config: ResolvedMemoryWikiConfig,
  overrides?: QuerySearchOverrides,
): ResolvedMemoryWikiConfig {
  if (!overrides?.searchBackend && !overrides?.searchCorpus) {
    return config;
  }
  return {
    ...config,
    search: {
      backend: overrides.searchBackend ?? config.search.backend,
      corpus: overrides.searchCorpus ?? config.search.corpus,
    },
  };
}

async function searchWikiCorpus(params: {
  config: ResolvedMemoryWikiConfig;
  query: string;
  maxResults: number;
  mode: WikiSearchMode;
  visibility: WikiPageVisibility | null;
  signal?: AbortSignal;
}): Promise<WikiSearchResult[]> {
  params.signal?.throwIfAborted();
  const snapshot = await loadMemoryWikiCompiledCache(params.config);
  const rootDir = params.config.vault.path;
  const candidatePaths = snapshot
    ? buildDigestCandidatePaths({
        snapshot,
        query: params.query,
        maxResults: params.maxResults,
        mode: params.mode,
      })
    : [];
  const search = (scope: Partial<Pick<WikiPageReadTask, "relativePaths" | "excludePaths">>) =>
    readMemoryWikiPages(
      {
        rootDir,
        visibility: params.visibility,
        select: "search",
        query: params.query,
        mode: params.mode,
        maxResults: params.maxResults,
        ...scope,
      },
      params.signal ? { signal: params.signal } : {},
    );
  // Each read returns its top maxResults; the merge below only ever consumes that many.
  const { results } = await search(
    candidatePaths.length > 0 ? { relativePaths: candidatePaths } : {},
  );
  if (candidatePaths.length === 0 || results.length >= params.maxResults) {
    return results;
  }

  const remaining = await search({ excludePaths: candidatePaths });
  return [...results, ...remaining.results];
}

async function readWikiPage(
  rootDir: string,
  relativePath: string,
  visibility: WikiPageVisibility | null,
  signal?: AbortSignal,
): Promise<QueryableWikiPage | null> {
  // One page is read on the calling thread with the reader the worker runs, so an
  // exact-path wiki_get or a digest claim read never waits behind a whole-vault scan.
  const { page } = await readWikiPagesTask(
    { rootDir, relativePaths: [relativePath], visibility, select: "page" },
    signal,
  );
  return page;
}

async function readExactWikiPage(
  rootDir: string,
  lookup: string,
  visibility: WikiPageVisibility | null,
  signal?: AbortSignal,
): Promise<QueryableWikiPage | null> {
  const relativePath = resolveExactWikiPagePath(lookup);
  if (!relativePath) {
    return null;
  }
  return readWikiPage(rootDir, relativePath, visibility, signal);
}

/** Resolve one page by path, basename or id after a whole-vault read in the reader worker. */
export async function readMemoryWikiPageByLookup(
  rootDir: string,
  lookup: string,
  options: { visibility?: WikiPageVisibility | null; signal?: AbortSignal } = {},
): Promise<QueryableWikiPage | null> {
  const { page } = await readMemoryWikiPages(
    { rootDir, visibility: options.visibility ?? null, select: "lookup", lookup },
    options.signal ? { signal: options.signal } : {},
  );
  return page;
}

export async function searchMemoryWiki(
  input: WikiQueryParams & {
    query: string;
    maxResults?: number;
    mode?: WikiSearchMode;
  },
): Promise<WikiSearchResult[]> {
  input.signal?.throwIfAborted();
  const agentId = resolveActiveMemoryAgentId(input);
  const params = agentId ? { ...input, agentId } : input;
  const protectedSessionRecall = params.conversationRecall?.corpus === "sessions";
  // Recall scope is runtime-owned; model corpus/backend overrides cannot widen it.
  const effectiveConfig = applySearchOverrides(
    params.config,
    protectedSessionRecall
      ? { searchBackend: params.config.search.backend, searchCorpus: "memory" }
      : params,
  );
  assertSessionVisibilityAppConfig({
    ...params,
    config: effectiveConfig,
    operation: "wiki_search",
  });
  await initializeMemoryWikiVault(
    effectiveConfig,
    params.signal ? { signal: params.signal } : undefined,
  );
  const maxResults = resolveIntegerOption(params.maxResults, 10, { min: 1 });
  const mode = params.mode ?? "auto";

  const wikiResults = shouldSearchWiki(effectiveConfig)
    ? await searchWikiCorpus({
        config: effectiveConfig,
        query: params.query,
        maxResults,
        mode,
        visibility: resolveWikiPageVisibility(params),
        ...(params.signal ? { signal: params.signal } : {}),
      })
    : [];
  params.signal?.throwIfAborted();

  const memoryResults = shouldSearchSharedMemory(effectiveConfig, params.appConfig)
    ? await searchSharedMemory(params, { maxResults, mode, protectedSessionRecall })
    : [];

  return mergeWikiSearchCorpusResults({
    wikiResults,
    memoryResults,
    maxResults,
    balanceCorpora: effectiveConfig.search.corpus === "all",
  });
}

export async function getMemoryWikiPage(
  input: WikiQueryParams & {
    lookup: string;
    fromLine?: number;
    lineCount?: number;
  },
): Promise<WikiGetResult | null> {
  const agentId = resolveActiveMemoryAgentId(input);
  const params = agentId ? { ...input, agentId } : input;
  const effectiveConfig = applySearchOverrides(params.config, params);
  assertSessionVisibilityAppConfig({
    ...params,
    config: effectiveConfig,
    operation: "wiki_get",
  });
  await initializeMemoryWikiVault(effectiveConfig);
  const fromLine = resolveIntegerOption(params.fromLine, 1, { min: 1 });
  const lineCount = resolveIntegerOption(params.lineCount, 200, { min: 1 });
  const sharedMemory = shouldSearchSharedMemory(effectiveConfig, params.appConfig);
  // Only native providers issue reference lookups; legacy owners resolve every lookup as a path.
  const reference =
    sharedMemory &&
    isMemoryReferenceLookup(params.lookup) &&
    (await usesNativeMemoryProvider(params))
      ? parseMemoryReferenceLookup(params.lookup)
      : null;

  if (!reference && shouldSearchWiki(effectiveConfig)) {
    const rootDir = effectiveConfig.vault.path;
    const visibility = resolveWikiPageVisibility(params);
    const digest = await loadMemoryWikiCompiledCache(effectiveConfig);
    const claimId = params.lookup.trim().replace(/^claim:/i, "");
    const digestClaimPagePath = digest?.claims.find((claim) => claim.id === claimId)?.pagePath;
    const digestLookupPage = digestClaimPagePath
      ? await readWikiPage(rootDir, digestClaimPagePath, visibility, params.signal)
      : null;
    // Claim IDs may themselves be paths; preserve their established lookup priority.
    const directLookupPage =
      digestLookupPage ??
      (await readExactWikiPage(rootDir, params.lookup, visibility, params.signal));
    const page =
      directLookupPage ??
      (await readMemoryWikiPageByLookup(rootDir, params.lookup, {
        visibility,
        ...(params.signal ? { signal: params.signal } : {}),
      }));
    if (page) {
      const lines = page.parsed.body.split(/\r?\n/);
      const totalLines = lines.length;
      const slice = lines.slice(fromLine - 1, fromLine - 1 + lineCount).join("\n");
      const truncated = fromLine - 1 + lineCount < totalLines;

      return {
        corpus: "wiki",
        path: page.relativePath,
        title: page.title,
        kind: page.kind,
        content: slice,
        fromLine,
        lineCount,
        totalLines,
        truncated,
        ...buildWikiResultMetadata(page),
      };
    }
  }

  if (!sharedMemory) {
    return null;
  }
  return await readSharedMemoryPage({ ...params, fromLine, lineCount }, reference);
}
