import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { resolveSessionAgentIdStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { MemoryReference, MemoryCitation } from "openclaw/plugin-sdk/memory-host-search";
import { resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { OpenClawConfig } from "../api.js";
import { assessClaimFreshness, isClaimContestedStatus } from "./claim-health.js";
import {
  loadMemoryWikiCompiledCache,
  type MemoryWikiCompiledCacheSnapshot,
  type MemoryWikiCompiledClaim,
  type MemoryWikiCompiledDigestPage,
} from "./compiled-cache.js";
import type { ResolvedMemoryWikiConfig, WikiSearchBackend, WikiSearchCorpus } from "./config.js";
import { type WikiClaim, type WikiPageSummary, WIKI_PAGE_GROUPS } from "./markdown.js";
import { isPersonLikePage } from "./person-page.js";
import {
  isMemoryReferenceLookup,
  parseMemoryReferenceLookup,
  resolveActiveMemoryAgentId,
  usesNativeMemoryProvider,
} from "./query-memory-provider.js";
import {
  listWikiMarkdownFiles,
  QUERY_PAGE_READ_CONCURRENCY,
  readQueryableWikiPages,
  readQueryableWikiPagesByPaths,
  type QueryableWikiPage,
} from "./query-pages.js";
import {
  normalizeLookupKey,
  readSharedMemoryPage,
  searchSharedMemory,
  shouldEnforceSessionVisibility,
  type SharedMemorySearchParams,
} from "./query-shared-memory.js";
import { initializeMemoryWikiVault } from "./vault.js";

const WIKI_SNIPPET_MAX_CHARS = 700;
const RELATED_BLOCK_PATTERN =
  /<!-- openclaw:wiki:related:start -->[\s\S]*?<!-- openclaw:wiki:related:end -->/g;
const MARKDOWN_FRONTMATTER_PATTERN = /^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const STRUCTURAL_MARKER_LINE_PATTERN = /^\s*<!--\s*openclaw:(?:wiki|human):[^>]*-->\s*$/;
const ROUTE_QUESTION_STOP_WORDS = new Set([
  "a",
  "about",
  "am",
  "an",
  "are",
  "ask",
  "asking",
  "be",
  "been",
  "being",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "help",
  "how",
  "i",
  "in",
  "is",
  "know",
  "knows",
  "me",
  "my",
  "need",
  "needs",
  "of",
  "on",
  "or",
  "our",
  "question",
  "questions",
  "should",
  "the",
  "to",
  "us",
  "we",
  "what",
  "when",
  "where",
  "who",
  "whom",
  "whose",
  "why",
  "with",
  "would",
]);

export const WIKI_SEARCH_MODES = [
  "auto",
  "find-person",
  "route-question",
  "source-evidence",
  "raw-claim",
] as const;

export type WikiSearchMode = (typeof WIKI_SEARCH_MODES)[number];

type WikiResultMetadata = {
  reference?: MemoryReference;
  lookup?: string;
  citations?: MemoryCitation[];
  title: string;
  kind: WikiPageSummary["kind"] | "memory";
  id?: string;
  sourceType?: string;
  provenanceMode?: string;
  sourcePath?: string;
  provenanceLabel?: string;
  updatedAt?: string;
};

type WikiSearchResult = WikiResultMetadata & {
  score: number;
  snippet: string;
  startLine?: number;
  endLine?: number;
  citation?: string;
  memorySource?: string;
  searchMode?: WikiSearchMode;
  entityType?: string;
  canonicalId?: string;
  aliases?: string[];
  privacyTier?: string;
  matchedClaimId?: string;
  matchedClaimStatus?: string;
  matchedClaimConfidence?: number;
  evidenceKinds?: string[];
  evidenceSourceIds?: string[];
} & WikiResultSource;

// Wiki pages and legacy memory read by path; native provider records use opaque lookups.
type WikiResultSource =
  | { corpus: "wiki"; path: string }
  | { corpus: "memory"; path: string; reference?: never; lookup?: never }
  | { corpus: "memory"; path?: never; reference: MemoryReference; lookup: string };

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

function sortWikiSearchResults(results: WikiSearchResult[]): WikiSearchResult[] {
  return results.toSorted((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.title.localeCompare(right.title);
  });
}

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

function buildSnippet(raw: string, query: string): string {
  const queryLower = normalizeLowercaseStringOrEmpty(query);
  const queryTokens = buildQueryTokens(queryLower);
  const searchable = buildSearchableBody(raw);
  const lines = searchable.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let matchingLine = lines.find((line) =>
    lineMatchesQuery(normalizeLowercaseStringOrEmpty(line), queryLower, queryTokens),
  );
  if (matchingLine === undefined && queryTokens.length > 0) {
    let bestHits = 0;
    for (const line of lines) {
      const lineLower = normalizeLowercaseStringOrEmpty(line);
      const hits = queryTokens.filter((token) => lineLower.includes(token)).length;
      if (hits > bestHits) {
        bestHits = hits;
        matchingLine = line;
      }
    }
  }
  return matchingLine?.trim() || lines.find((line) => line.trim() !== "---")?.trim() || "";
}

function buildPageSearchFields(
  page: QueryableWikiPage | MemoryWikiCompiledDigestPage,
  relationships: WikiPageSummary["relationships"] | undefined,
): string[] {
  return [
    page.pageType ?? "",
    page.entityType ?? "",
    page.canonicalId ?? "",
    page.aliases?.join(" ") ?? "",
    page.sourceIds.join(" "),
    page.questions.join(" "),
    page.contradictions.join(" "),
    page.privacyTier ?? "",
    page.bestUsedFor?.join(" ") ?? "",
    page.notEnoughFor?.join(" ") ?? "",
    page.personCard?.canonicalId ?? "",
    page.personCard?.handles.join(" ") ?? "",
    page.personCard?.socials.join(" ") ?? "",
    page.personCard?.emails.join(" ") ?? "",
    page.personCard?.timezone ?? "",
    page.personCard?.lane ?? "",
    page.personCard?.askFor.join(" ") ?? "",
    page.personCard?.avoidAskingFor.join(" ") ?? "",
    page.personCard?.bestUsedFor.join(" ") ?? "",
    page.personCard?.notEnoughFor.join(" ") ?? "",
    relationships
      ?.flatMap((relationship) => [
        relationship.targetId ?? "",
        relationship.targetPath ?? "",
        relationship.targetTitle ?? "",
        relationship.kind ?? "",
        relationship.evidenceKind ?? "",
        relationship.note ?? "",
      ])
      .join(" ") ?? "",
  ];
}

function buildPageSearchText(page: QueryableWikiPage): string {
  return [
    page.title,
    page.relativePath,
    page.id ?? "",
    JSON.stringify(page.parsed.frontmatter),
    ...buildPageSearchFields(page, page.relationships),
    page.claims.map((claim) => claim.text).join(" "),
    page.claims.map((claim) => claim.id ?? "").join(" "),
    page.claims
      .flatMap((claim) =>
        claim.evidence.flatMap((evidence) => [
          evidence.kind ?? "",
          evidence.sourceId ?? "",
          evidence.path ?? "",
          evidence.lines ?? "",
          evidence.note ?? "",
          evidence.privacyTier ?? "",
        ]),
      )
      .join(" "),
  ]
    .filter(Boolean)
    .join("\n");
}

function buildSearchableBody(raw: string): string {
  return raw
    .replace(RELATED_BLOCK_PATTERN, "")
    .replace(MARKDOWN_FRONTMATTER_PATTERN, "")
    .split(/\r?\n/)
    .filter((line) => !STRUCTURAL_MARKER_LINE_PATTERN.test(line))
    .join("\n");
}

function buildQueryTokens(queryLower: string): string[] {
  return [
    ...new Set(
      queryLower
        .split(/[^\p{L}\p{N}\p{M}@._-]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  ];
}

function buildRouteQuestionTokens(queryLower: string): string[] {
  const tokens = buildQueryTokens(queryLower);
  const routedTokens = tokens.filter((token) => !ROUTE_QUESTION_STOP_WORDS.has(token));
  return routedTokens.length > 0 ? routedTokens : tokens;
}

function lineMatchesQuery(
  lineLower: string,
  queryLower: string,
  queryTokens: readonly string[],
): boolean {
  if (queryLower.length > 0 && lineLower.includes(queryLower)) {
    return true;
  }
  return queryTokens.length > 0 && queryTokens.every((token) => lineLower.includes(token));
}

function buildDigestPageSearchText(
  page: MemoryWikiCompiledDigestPage,
  claims: MemoryWikiCompiledClaim[],
): string {
  return [
    page.title,
    page.path,
    page.id ?? "",
    ...buildPageSearchFields(page, page.topRelationships),
    claims.map((claim) => claim.text).join(" "),
    claims.map((claim) => claim.id ?? "").join(" "),
    claims.map((claim) => claim.evidenceKinds?.join(" ") ?? "").join(" "),
    claims.map((claim) => claim.privacyTiers?.join(" ") ?? "").join(" "),
  ]
    .filter(Boolean)
    .join("\n");
}

function isClaimTextOrIdMatch(
  claim: Pick<WikiClaim, "id" | "text">,
  queryLower: string,
  queryTokens: readonly string[] = buildQueryTokens(queryLower),
): boolean {
  const textLower = normalizeLowercaseStringOrEmpty(claim.text);
  if (lineMatchesQuery(textLower, queryLower, queryTokens)) {
    return true;
  }
  return lineMatchesQuery(normalizeLowercaseStringOrEmpty(claim.id), queryLower, queryTokens);
}

function scoreClaimMatch(params: {
  text: string;
  id?: string;
  confidence?: number;
  status?: string;
  freshnessLevel?: string;
  queryLower: string;
  queryTokens?: readonly string[];
}): number {
  let score = 0;
  if (normalizeLowercaseStringOrEmpty(params.text).includes(params.queryLower)) {
    score += 25;
  } else if (
    params.queryTokens?.length &&
    params.queryTokens.every((token) =>
      normalizeLowercaseStringOrEmpty(params.text).includes(token),
    )
  ) {
    score += 18;
  }
  if (normalizeLowercaseStringOrEmpty(params.id).includes(params.queryLower)) {
    score += 10;
  }
  if (typeof params.confidence === "number") {
    score += Math.round(params.confidence * 10);
  }
  switch (params.freshnessLevel) {
    case "fresh":
      score += 8;
      break;
    case "aging":
      score += 4;
      break;
    case "stale":
      score -= 2;
      break;
    case "unknown":
      score -= 4;
      break;
    case undefined:
      break;
  }
  score += isClaimContestedStatus(params.status) ? -6 : 4;
  return score;
}

function hasAnyQueryMatch(
  values: readonly (string | undefined)[],
  queryLower: string,
  queryTokens: readonly string[],
) {
  return values.some((value) =>
    lineMatchesQuery(normalizeLowercaseStringOrEmpty(value), queryLower, queryTokens),
  );
}

function buildRouteQuestionFields(
  page: QueryableWikiPage | MemoryWikiCompiledDigestPage,
): string[] {
  const relationships = "relationships" in page ? page.relationships : page.topRelationships;
  return [
    page.personCard?.lane,
    ...(page.personCard?.askFor ?? []),
    ...(page.personCard?.avoidAskingFor ?? []),
    ...(page.bestUsedFor ?? []),
    ...(page.notEnoughFor ?? []),
    ...(page.personCard?.bestUsedFor ?? []),
    ...(page.personCard?.notEnoughFor ?? []),
    ...(relationships?.flatMap((relationship) => [
      relationship.kind,
      relationship.targetTitle,
      relationship.note,
    ]) ?? []),
  ].filter((value): value is string => Boolean(value));
}

function hasRouteQuestionMatch(values: readonly string[], queryLower: string): boolean {
  return hasAnyQueryMatch(values, queryLower, buildRouteQuestionTokens(queryLower));
}

function scoreWikiSearchModeBoost(params: {
  page: QueryableWikiPage | MemoryWikiCompiledDigestPage;
  claims: readonly (WikiClaim | MemoryWikiCompiledClaim)[];
  matchingClaimCount: number;
  queryLower: string;
  queryTokens: readonly string[];
  mode: WikiSearchMode;
}): number {
  const { page, queryLower, queryTokens } = params;
  switch (params.mode) {
    case "auto":
      return 0;
    case "find-person": {
      let score = isPersonLikePage(page) ? 24 : -4;
      if (
        hasAnyQueryMatch(
          [
            page.canonicalId,
            ...(page.aliases ?? []),
            page.personCard?.canonicalId,
            ...(page.personCard?.handles ?? []),
            ...(page.personCard?.emails ?? []),
            ...(page.personCard?.socials ?? []),
          ],
          queryLower,
          queryTokens,
        )
      ) {
        score += 24;
      }
      return score;
    }
    case "route-question": {
      let score = isPersonLikePage(page) ? 14 : 0;
      if (hasRouteQuestionMatch(buildRouteQuestionFields(page), queryLower)) {
        score += 32;
      }
      // Digests retain only top relationships; ranking still uses the full count.
      const relationshipCount =
        "relationships" in page ? page.relationships.length : (page.relationshipCount ?? 0);
      return score + Math.min(8, relationshipCount * 2);
    }
    case "source-evidence": {
      let score = page.kind === "source" ? 22 : 0;
      const evidenceFields = params.claims.flatMap((claim) =>
        "evidence" in claim
          ? claim.evidence.flatMap((evidence) => [
              evidence.kind,
              evidence.sourceId,
              evidence.path,
              evidence.lines,
              evidence.note,
            ])
          : [
              ...(claim.sourceIds ?? []),
              ...(claim.evidenceKinds ?? []),
              ...(claim.privacyTiers ?? []),
            ],
      );
      if (
        hasAnyQueryMatch(
          [
            "sourcePath" in page ? page.sourcePath : undefined,
            ...page.sourceIds,
            ...evidenceFields,
          ],
          queryLower,
          queryTokens,
        )
      ) {
        score += 30;
      }
      return score;
    }
    case "raw-claim":
      return params.matchingClaimCount > 0 ? 42 : 0;
  }
  return 0;
}

function buildDigestCandidatePaths(params: {
  snapshot: MemoryWikiCompiledCacheSnapshot;
  query: string;
  maxResults: number;
  mode: WikiSearchMode;
}): string[] {
  const queryLower = normalizeLowercaseStringOrEmpty(params.query);
  const queryTokens = buildQueryTokens(queryLower);
  const claimsByPage = new Map<string, MemoryWikiCompiledClaim[]>();
  for (const claim of params.snapshot.claims) {
    const current = claimsByPage.get(claim.pagePath) ?? [];
    current.push(claim);
    claimsByPage.set(claim.pagePath, current);
  }

  return params.snapshot.digest.pages
    .map((page) => {
      const claims = claimsByPage.get(page.path) ?? [];
      const metadataLower = normalizeLowercaseStringOrEmpty(
        buildDigestPageSearchText(page, claims),
      );
      if (
        !metadataLower.includes(queryLower) &&
        !(
          params.mode === "route-question" &&
          hasRouteQuestionMatch(buildRouteQuestionFields(page), queryLower)
        )
      ) {
        return { path: page.path, score: 0 };
      }
      const matchingClaims = getMatchingClaims(claims, queryLower, queryTokens, (claim) =>
        scoreClaimMatch({ ...claim, queryLower, queryTokens }),
      );
      const score = scorePage({
        page,
        claims,
        matchingClaims,
        queryLower,
        queryTokens,
        mode: params.mode,
      });
      return { path: page.path, score };
    })
    .filter((candidate) => candidate.score > 0)
    .toSorted((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.path.localeCompare(right.path);
    })
    .slice(0, Math.max(params.maxResults * 4, 20))
    .map((candidate) => candidate.path);
}

function getMatchingClaims<Claim extends Pick<WikiClaim, "id" | "text">>(
  claims: readonly Claim[],
  queryLower: string,
  queryTokens: readonly string[],
  score: (claim: Claim) => number,
): Array<{ claim: Claim; score: number }> {
  return claims
    .filter((claim) => isClaimTextOrIdMatch(claim, queryLower, queryTokens))
    .map((claim) => ({ claim, score: score(claim) }))
    .toSorted((left, right) => right.score - left.score);
}

function scorePage(params: {
  page: QueryableWikiPage | MemoryWikiCompiledDigestPage;
  claims: readonly (WikiClaim | MemoryWikiCompiledClaim)[];
  matchingClaims: readonly { score: number }[];
  queryLower: string;
  queryTokens: readonly string[];
  mode: WikiSearchMode;
}): number {
  const { page, claims, matchingClaims, queryLower, queryTokens, mode } = params;
  const titleLower = normalizeLowercaseStringOrEmpty(page.title);
  const pathLower = normalizeLowercaseStringOrEmpty(
    "relativePath" in page ? page.relativePath : page.path,
  );
  const idLower = normalizeLowercaseStringOrEmpty(page.id);
  let score = 1;
  if (titleLower === queryLower) {
    score += 50;
  } else if (titleLower.includes(queryLower)) {
    score += 20;
  }
  if (pathLower.includes(queryLower)) {
    score += 10;
  }
  if (idLower.includes(queryLower)) {
    score += 20;
  }
  if (page.sourceIds.some((id) => normalizeLowercaseStringOrEmpty(id).includes(queryLower))) {
    score += 12;
  }
  const [bestMatchingClaim] = matchingClaims;
  if (bestMatchingClaim) {
    score += bestMatchingClaim.score;
    score += Math.min(10, (matchingClaims.length - 1) * 2);
  }
  score += scoreWikiSearchModeBoost({
    page,
    claims,
    matchingClaimCount: matchingClaims.length,
    queryLower,
    queryTokens,
    mode,
  });
  // Digest candidates use metadata only. Live pages also admit distributed token
  // matches and score their body, without changing the digest prefilter's recall.
  if (!("raw" in page)) {
    return score;
  }
  const metadataLower = normalizeLowercaseStringOrEmpty(buildPageSearchText(page));
  const rawLower = normalizeLowercaseStringOrEmpty(buildSearchableBody(page.raw));
  const fields = [titleLower, pathLower, idLower, metadataLower, rawLower];
  const combinedLower = fields.join("\n");
  if (
    !fields.some((field) => field.includes(queryLower)) &&
    !(queryTokens.length > 0 && queryTokens.every((token) => combinedLower.includes(token))) &&
    !(
      mode === "route-question" && hasRouteQuestionMatch(buildRouteQuestionFields(page), queryLower)
    )
  ) {
    return 0;
  }
  score += Math.min(10, rawLower.split(queryLower).length - 1);
  for (const token of queryTokens) {
    if (titleLower.includes(token)) {
      score += 8;
    }
    if (pathLower.includes(token) || idLower.includes(token)) {
      score += 6;
    }
    if (metadataLower.includes(token)) {
      score += 4;
    }
    if (rawLower.includes(token)) {
      score += 1;
    }
  }
  return score;
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

function isBridgeCompiledPage(page: QueryableWikiPage): boolean {
  return (
    page.sourceType === "memory-bridge" ||
    page.sourceType === "memory-bridge-events" ||
    page.bridgeAgentIds.length > 0
  );
}

function createWikiPageVisibilityFilter(params: {
  appConfig?: OpenClawConfig;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
}): (page: QueryableWikiPage) => boolean {
  if (params.sandboxed !== true) {
    return () => true;
  }
  const sessionKey = params.agentSessionKey?.trim();
  const scopedAgentId = normalizeLowercaseStringOrEmpty(
    params.agentId?.trim() ||
      (params.appConfig && sessionKey
        ? resolveSessionAgentIdStrict({ sessionKey, config: params.appConfig })
        : undefined),
  );
  return (page) =>
    !isBridgeCompiledPage(page) ||
    (scopedAgentId.length > 0 &&
      page.bridgeAgentIds.some(
        (agentId) => normalizeLowercaseStringOrEmpty(agentId) === scopedAgentId,
      ));
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

function buildWikiProvenanceLabel(page: WikiPageSummary): string | undefined {
  if (page.sourceType === "memory-bridge-events") {
    return `bridge events: ${page.bridgeRelativePath ?? page.relativePath}`;
  }
  if (page.sourceType === "memory-bridge") {
    return `bridge: ${page.bridgeRelativePath ?? page.relativePath}`;
  }
  if (page.provenanceMode === "unsafe-local" || page.sourceType === "memory-unsafe-local") {
    return `unsafe-local: ${page.unsafeLocalRelativePath ?? page.relativePath}`;
  }
  return undefined;
}

function buildWikiResultMetadata(page: WikiPageSummary) {
  const provenanceLabel = buildWikiProvenanceLabel(page);
  return {
    ...(page.id ? { id: page.id } : {}),
    ...(page.sourceType ? { sourceType: page.sourceType } : {}),
    ...(page.provenanceMode ? { provenanceMode: page.provenanceMode } : {}),
    ...(page.sourcePath ? { sourcePath: page.sourcePath } : {}),
    ...(provenanceLabel ? { provenanceLabel } : {}),
    ...(page.updatedAt ? { updatedAt: page.updatedAt } : {}),
    ...(page.entityType ? { entityType: page.entityType } : {}),
    ...(page.canonicalId ? { canonicalId: page.canonicalId } : {}),
    ...(page.aliases.length > 0 ? { aliases: [...page.aliases] } : {}),
    ...(page.privacyTier ? { privacyTier: page.privacyTier } : {}),
  };
}

function toWikiSearchResult(
  page: QueryableWikiPage,
  query: string,
  mode: WikiSearchMode,
): WikiSearchResult {
  const queryLower = normalizeLowercaseStringOrEmpty(query);
  const queryTokens = buildQueryTokens(queryLower);
  const matchingClaims = getMatchingClaims(page.claims, queryLower, queryTokens, (claim) =>
    scoreClaimMatch({
      ...claim,
      freshnessLevel: assessClaimFreshness({ page, claim }).level,
      queryLower,
      queryTokens,
    }),
  );
  const matchingClaim = matchingClaims[0]?.claim;
  return {
    corpus: "wiki",
    path: page.relativePath,
    title: page.title,
    kind: page.kind,
    score: scorePage({ page, claims: page.claims, matchingClaims, queryLower, queryTokens, mode }),
    snippet: truncateUtf16Safe(
      matchingClaim?.text ?? buildSnippet(page.raw, query),
      WIKI_SNIPPET_MAX_CHARS,
    ),
    searchMode: mode,
    ...buildWikiResultMetadata(page),
    ...(matchingClaim
      ? {
          ...(matchingClaim.id ? { matchedClaimId: matchingClaim.id } : {}),
          ...(matchingClaim.status ? { matchedClaimStatus: matchingClaim.status } : {}),
          ...(typeof matchingClaim.confidence === "number"
            ? { matchedClaimConfidence: matchingClaim.confidence }
            : {}),
          evidenceKinds: uniqueStrings(
            matchingClaim.evidence.flatMap((evidence) => evidence.kind ?? []),
          ),
          evidenceSourceIds: uniqueStrings(
            matchingClaim.evidence.flatMap((evidence) => evidence.sourceId ?? []),
          ),
        }
      : {}),
  };
}

async function searchWikiCorpus(params: {
  config: ResolvedMemoryWikiConfig;
  query: string;
  maxResults: number;
  mode: WikiSearchMode;
  canReadPage: (page: QueryableWikiPage) => boolean;
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
  const candidatePages =
    candidatePaths.length > 0
      ? await readQueryableWikiPagesByPaths(rootDir, candidatePaths, params.signal)
      : await readQueryableWikiPages(rootDir, params.signal);
  const results: WikiSearchResult[] = [];
  const scorePages = async (pages: QueryableWikiPage[]) => {
    let index = 0;
    for (const page of pages) {
      // Let deadlines and turn cancellation run during CPU-bound scoring too.
      if (params.signal && index++ % QUERY_PAGE_READ_CONCURRENCY === 0) {
        await setImmediate();
      }
      params.signal?.throwIfAborted();
      if (params.canReadPage(page)) {
        const result = toWikiSearchResult(page, params.query, params.mode);
        if (result.score > 0) {
          results.push(result);
        }
      }
    }
  };
  await scorePages(candidatePages);
  if (candidatePaths.length === 0 || results.length >= params.maxResults) {
    return results;
  }

  const seenPaths = new Set(candidatePages.map((page) => page.relativePath));
  const remainingPaths = (await listWikiMarkdownFiles(rootDir)).filter(
    (relativePath) => !seenPaths.has(relativePath),
  );
  const remainingPages = await readQueryableWikiPagesByPaths(
    rootDir,
    remainingPaths,
    params.signal,
  );
  await scorePages(remainingPages);
  return results;
}

async function readExactWikiPage(
  rootDir: string,
  lookup: string,
): Promise<QueryableWikiPage | null> {
  const relativePath = resolveExactWikiPagePath(lookup);
  if (!relativePath) {
    return null;
  }
  return (await readQueryableWikiPagesByPaths(rootDir, [relativePath]))[0] ?? null;
}

export function resolveQueryableWikiPageByLookup(
  pages: QueryableWikiPage[],
  lookup: string,
): QueryableWikiPage | null {
  const key = normalizeLookupKey(lookup);
  const withExtension = key.endsWith(".md") ? key : `${key}.md`;
  return (
    pages.find((page) => page.relativePath === key) ??
    pages.find((page) => page.relativePath === withExtension) ??
    pages.find((page) => page.relativePath.replace(/\.md$/i, "") === key) ??
    pages.find((page) => path.basename(page.relativePath, ".md") === key) ??
    pages.find((page) => page.id === key) ??
    null
  );
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
        canReadPage: createWikiPageVisibilityFilter(params),
        signal: params.signal,
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
    const canReadPage = createWikiPageVisibilityFilter(params);
    const digest = await loadMemoryWikiCompiledCache(effectiveConfig);
    const claimId = params.lookup.trim().replace(/^claim:/i, "");
    const digestClaimPagePath = digest?.claims.find((claim) => claim.id === claimId)?.pagePath;
    const digestLookupPage = digestClaimPagePath
      ? ((
          await readQueryableWikiPagesByPaths(effectiveConfig.vault.path, [digestClaimPagePath])
        ).find(canReadPage) ?? null)
      : null;
    // Claim IDs may themselves be paths; preserve their established lookup priority.
    const directLookupPage =
      digestLookupPage ?? (await readExactWikiPage(effectiveConfig.vault.path, params.lookup));
    const pages =
      directLookupPage && canReadPage(directLookupPage)
        ? [directLookupPage]
        : (await readQueryableWikiPages(effectiveConfig.vault.path)).filter(canReadPage);
    const page = digestLookupPage ?? resolveQueryableWikiPageByLookup(pages, params.lookup);
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

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
