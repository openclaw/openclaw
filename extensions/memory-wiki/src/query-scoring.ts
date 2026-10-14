// Query scoring for live wiki pages and compiled digest entries: pure functions
// over page and digest data, shared by the host prefilter and the reader worker.
import type { MemoryReference, MemoryCitation } from "openclaw/plugin-sdk/memory-host-search";
import {
  normalizeLowercaseStringOrEmpty,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { assessClaimFreshness, isClaimContestedStatus } from "./claim-health.js";
import type {
  MemoryWikiCompiledCacheSnapshot,
  MemoryWikiCompiledClaim,
  MemoryWikiCompiledDigestPage,
} from "./compiled-cache.js";
import type { ParsedWikiMarkdown, WikiClaim, WikiPageSummary } from "./markdown.js";
import { isPersonLikePage } from "./person-page.js";

/** A wiki page as read for queries: its summary plus raw text and parsed markdown. */
export type QueryableWikiPage = WikiPageSummary & {
  raw: string;
  parsed: ParsedWikiMarkdown;
};

export const WIKI_SEARCH_MODES = [
  "auto",
  "find-person",
  "route-question",
  "source-evidence",
  "raw-claim",
] as const;

export type WikiSearchMode = (typeof WIKI_SEARCH_MODES)[number];

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

export type WikiResultMetadata = {
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

export type WikiSearchResult = WikiResultMetadata & {
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
export type WikiResultSource =
  | { corpus: "wiki"; path: string }
  | { corpus: "memory"; path: string; reference?: never; lookup?: never }
  | { corpus: "memory"; path?: never; reference: MemoryReference; lookup: string };

export function sortWikiSearchResults(results: WikiSearchResult[]): WikiSearchResult[] {
  return results.toSorted((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.title.localeCompare(right.title);
  });
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

export function buildDigestCandidatePaths(params: {
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
        !lineMatchesQuery(metadataLower, queryLower, queryTokens) &&
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
  // Digest candidates admit phrase and distributed token matches in metadata.
  // Live pages also match and score their body text.
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

export function buildWikiResultMetadata(page: WikiPageSummary) {
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

export function toWikiSearchResult(
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
