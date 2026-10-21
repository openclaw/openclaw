import type { DatabaseSync } from "node:sqlite";
import { CompiledQuery } from "kysely";
import {
  admitStoreSearch,
  type TextQuery,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import {
  normalizeStringEntriesLower,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  bm25RankToScore,
  buildMatchQueryFromTerms,
  planKeywordSearch,
  tokenizeFtsQuery,
} from "./keyword-query.js";
import {
  projectMemorySearchRow,
  resolveSnippetProjection,
  type MemorySearchRow,
  type SearchRowResult,
} from "./manager-search-shared.js";
import { buildSqliteMemorySourceFilter, type MemorySourceFilter } from "./source-filter.js";

const EXACT_PATH_SPECIFICITY_SQL_FUNCTION = "openclaw_memory_exact_path_specificity";
const NORMALIZED_CONTAINS_SQL_FUNCTION = "openclaw_memory_normalized_contains";
// Since SQLite 3.47 a bare bound LIMIT value or LIKE pattern is plan-relevant
// (sqlite3ExprIsInteger and isLikeOrGlob call sqlite3VdbeSetVarmask; 3.53.4
// select.c:2538, whereexpr.c:208-215), and node:sqlite clears bindings before
// every run, so such a statement recompiles each time. Search SQL binds them as
// `LIMIT +?` and `LIKE (? || '')` instead; no LIKE here can use an index.

function loadKeywordRowsWithFallback<T>(
  plan: { matchQuery: TextQuery | null; substringTerms: string[] },
  loadRows: (matchQuery: TextQuery | null, terms: string[]) => T[],
  fallbackTokens: () => string[],
  warning: string,
): { rows: T[]; usedMatch: boolean } {
  if (plan.matchQuery) {
    try {
      return { rows: loadRows(plan.matchQuery, plan.substringTerms), usedMatch: true };
    } catch (error) {
      console.warn(`${warning}: ${String(error)}`);
      return {
        rows: loadRows(null, uniqueStrings([...fallbackTokens(), ...plan.substringTerms])),
        usedMatch: false,
      };
    }
  }
  return { rows: loadRows(null, plan.substringTerms), usedMatch: false };
}

type PathKeywordSearchResult = SearchRowResult & {
  textScore: 0;
  pathScore: number;
  exactPathSpecificity: ExactPathSpecificity;
  hasBodyMatch: false;
};

function mergePathKeywordScores(target: PathKeywordSearchResult, hit: PathKeywordSearchResult) {
  target.pathScore = Math.max(target.pathScore, hit.pathScore);
  target.score = Math.max(target.score, hit.score);
  target.exactPathSpecificity = Math.max(
    target.exactPathSpecificity,
    hit.exactPathSpecificity,
  ) as ExactPathSpecificity;
}

function comparePathKeywordSearchResults(
  left: PathKeywordSearchResult,
  right: PathKeywordSearchResult,
): number {
  const specificityDelta = right.exactPathSpecificity - left.exactPathSpecificity;
  if (specificityDelta !== 0) {
    return specificityDelta;
  }
  if (left.exactPathSpecificity === 0) {
    const pathDelta = right.pathScore - left.pathScore;
    if (pathDelta !== 0) {
      return pathDelta;
    }
  }
  return (
    left.path.localeCompare(right.path) ||
    left.startLine - right.startLine ||
    left.id.localeCompare(right.id)
  );
}

export type ExactPathSpecificity = 0 | 1 | 2 | 3;

function normalizeSearchTokens(raw: string): string[] {
  return normalizeStringEntriesLower(tokenizeFtsQuery(raw.normalize("NFC")));
}

function literalSearchMatcher(value: string, whole = false): RegExp {
  const literal = escapeRegExp(value.normalize("NFC"));
  return new RegExp(whole ? `^(?:${literal})$` : literal, "iu");
}

function scoreFallbackKeywordResult(params: {
  queryMatchers: Array<{ word: RegExp; substring: RegExp }>;
  path: string;
  text: string;
  ftsScore: number;
}): number {
  const { queryMatchers } = params;
  if (queryMatchers.length === 0) {
    return params.ftsScore;
  }

  const textTokens = normalizeSearchTokens(params.text);
  const textTokenSet = new Set(textTokens);
  const overlap = queryMatchers.filter(({ word }) =>
    textTokens.some((token) => word.test(token)),
  ).length;
  const uniqueQueryOverlap = overlap / queryMatchers.length;
  const density = overlap / Math.max(textTokenSet.size, 1);
  const normalizedPath = params.path.normalize("NFC");
  const pathBoost = queryMatchers.reduce(
    (score, { substring }) => score + (substring.test(normalizedPath) ? 0.18 : 0),
    0,
  );
  const textLengthBoost = Math.min(params.text.length / 160, 0.18);

  const lexicalBoost = uniqueQueryOverlap * 0.45 + density * 0.2 + pathBoost + textLengthBoost;
  // Scale boosts into the remaining headroom so relevance survives recency weighting.
  return (params.ftsScore + lexicalBoost) / (1 + lexicalBoost);
}

function escapeLikePattern(term: string): string {
  return term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function isAscii(value: string): boolean {
  return !/[^\p{ASCII}]/u.test(value);
}

function resolveUnicodeCandidateAnchors(value: string): string[] {
  const firstNonAsciiCodePoint = Array.from(value).find((codePoint) => !isAscii(codePoint));
  if (!firstNonAsciiCodePoint) {
    return [];
  }
  return [
    ...new Set([
      firstNonAsciiCodePoint,
      firstNonAsciiCodePoint.toLowerCase(),
      firstNonAsciiCodePoint.toUpperCase(),
    ]),
  ];
}

function normalizePathIdentifier(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").normalize("NFC").toLowerCase();
}

export function prepareExactPathMatcher(
  query: string,
): (candidatePath: string) => ExactPathSpecificity {
  const normalizedQuery = normalizePathIdentifier(query);
  if (!normalizedQuery || normalizedQuery === ".") {
    return () => 0;
  }
  const hasDirectory = normalizedQuery.includes("/");
  return (candidatePath) => {
    const normalizedPath = normalizePathIdentifier(candidatePath);
    if (normalizedQuery === normalizedPath) {
      return 3;
    }
    if (hasDirectory) {
      return 0;
    }
    const basename = normalizedPath.split("/").at(-1) ?? normalizedPath;
    if (normalizedQuery === basename) {
      return 2;
    }
    const extensionIndex = basename.lastIndexOf(".");
    const stem = extensionIndex > 0 ? basename.slice(0, extensionIndex) : basename;
    return normalizedQuery === stem ? 1 : 0;
  };
}

type SearchSqlFunctionState = {
  substringMatchers: ReadonlyMap<string, RegExp>;
  matchExactPath: (candidatePath: string) => ExactPathSpecificity;
};

// Replacing a SQL function expires every prepared statement on the connection,
// so register once per connection and let each search swap the state read here.
// Searches set it and run their statements synchronously, so it is fixed for a
// whole statement run; every call site passes a column, never a constant.
const searchSqlFunctions = new WeakMap<DatabaseSync, SearchSqlFunctionState>();

function resolveSearchSqlFunctions(db: DatabaseSync): SearchSqlFunctionState {
  const registered = searchSqlFunctions.get(db);
  if (registered) {
    return registered;
  }
  const state: SearchSqlFunctionState = { substringMatchers: new Map(), matchExactPath: () => 0 };
  db.function(NORMALIZED_CONTAINS_SQL_FUNCTION, { deterministic: true }, (value, query) =>
    typeof value === "string" && typeof query === "string"
      ? Number(state.substringMatchers.get(query)?.test(value.normalize("NFC")) === true)
      : 0,
  );
  db.function(EXACT_PATH_SPECIFICITY_SQL_FUNCTION, { deterministic: true }, (candidatePath) =>
    typeof candidatePath === "string" ? state.matchExactPath(candidatePath) : 0,
  );
  searchSqlFunctions.set(db, state);
  return state;
}

function registerSubstringSqlFunction(db: DatabaseSync, terms: readonly string[]): void {
  // Prepare bound literals once. Unicode ignore-case uses simple folding;
  // lowercasing is contextual and LIKE/upper-lower anchors miss equivalent forms.
  resolveSearchSqlFunctions(db).substringMatchers = new Map(
    terms.map((term) => [term, literalSearchMatcher(term)]),
  );
}

function buildSubstringFilter(terms: string[], column: string, matchAny = false): string {
  if (terms.length === 0) {
    return "";
  }
  const predicates = terms.map(() => `${NORMALIZED_CONTAINS_SQL_FUNCTION}(${column}, ?) = 1`);
  return ` AND (${predicates.join(matchAny ? " OR " : " AND ")})`;
}

function buildExactPathCandidatePatterns(query: string): string[] {
  const normalized = query.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized === ".") {
    return [];
  }
  const canonicalForms = [normalized.normalize("NFC"), normalized.normalize("NFD")];
  const forms = new Set(canonicalForms);
  if (!isAscii(normalized)) {
    for (const form of canonicalForms) {
      forms.add(form.toLowerCase());
      forms.add(form.toUpperCase());
    }
  }
  const patterns = new Set<string>();
  for (const form of forms) {
    const escaped = escapeLikePattern(form);
    if (normalized.includes("/")) {
      patterns.add(escaped);
      continue;
    }
    patterns.add(escaped);
    patterns.add(`${escaped}.%`);
    patterns.add(`%/${escaped}`);
    patterns.add(`%/${escaped}.%`);
  }
  if (!isAscii(normalized)) {
    const asciiAnchor = normalized
      .normalize("NFD")
      .toLowerCase()
      .match(/[a-z0-9_]+/g)
      ?.toSorted((left, right) => right.length - left.length)[0];
    if (asciiAnchor) {
      patterns.add(`%${escapeLikePattern(asciiAnchor)}%`);
    }
    if (normalized.toLowerCase() !== normalized.toUpperCase()) {
      // SQLite LIKE cannot enumerate mixed-case Unicode forms. Bound the JS
      // casefold predicate with explicit lower/upper Unicode anchors.
      for (const anchor of resolveUnicodeCandidateAnchors(normalized)) {
        patterns.add(`%${escapeLikePattern(anchor)}%`);
      }
    }
  }
  return [...patterns];
}

function planPathKeywordSearch(params: {
  query: string;
  ftsTokenizer?: "unicode61" | "trigram";
}): Array<{ query: string; matchQuery: TextQuery | null; substringTerms: string[] }> {
  const forms =
    params.ftsTokenizer === "trigram"
      ? new Set([params.query.normalize("NFC"), params.query.normalize("NFD")])
      : new Set([params.query]);
  const seen = new Set<string>();
  const plans: Array<{ query: string; matchQuery: TextQuery | null; substringTerms: string[] }> =
    [];
  const addPlan = (
    query: string,
    plan: { matchQuery: TextQuery | null; substringTerms: string[] },
  ) => {
    const key = JSON.stringify([plan.matchQuery, plan.substringTerms]);
    if (!seen.has(key)) {
      seen.add(key);
      plans.push({ query, ...plan });
    }
  };
  for (const query of forms) {
    const plan = planKeywordSearch({
      ...params,
      query,
      includeLeadingMarks: true,
    });
    addPlan(query, plan);
  }
  if (params.ftsTokenizer !== "trigram") {
    for (const query of new Set([params.query.normalize("NFC"), params.query.normalize("NFD")])) {
      const tokens = tokenizeFtsQuery(query, true);
      const substringTerms = tokens.filter((token) => !isAscii(token));
      if (substringTerms.length > 0) {
        const matchQuery = buildMatchQueryFromTerms(tokens.filter(isAscii));
        // unicode61 matches whole tokens only. Add a bounded Unicode-aware
        // substring plan while ASCII terms remain constrained by MATCH.
        addPlan(query, { matchQuery, substringTerms });
      }
    }
  }
  return plans;
}

export async function searchKeyword(params: {
  db: DatabaseSync;
  ftsTable: string;
  query: string;
  ftsTokenizer?: "unicode61" | "trigram";
  limit: number;
  snippetMaxChars: number;
  sourceFilter: MemorySourceFilter;
  boostFallbackRanking?: boolean;
  matchAny?: boolean;
}): Promise<Array<SearchRowResult & { textScore: number; hasBodyMatch: true }>> {
  if (params.limit <= 0) {
    return [];
  }
  const plan = planKeywordSearch({
    query: params.query,
    ftsTokenizer: params.ftsTokenizer,
    canonicalVariants: true,
    matchAny: params.matchAny,
  });
  if (!plan.matchQuery && plan.substringTerms.length === 0) {
    return [];
  }

  const sourceFilter = buildSqliteMemorySourceFilter(params.sourceFilter, params.ftsTable);
  const search = admitStoreSearch(params.db, {
    text: { body: { table: params.ftsTable, fields: ["text"], hiddenRank: true } },
  });
  if (!search.fullText) {
    throw new Error(search.diagnostics.join("; "));
  }
  const fullText = search.fullText;
  const index = search.text.body!;
  const dialect = getNodeSqliteKysely(params.db);
  const ranking = fullText.rank(index);
  const rank = ranking.value.compile(dialect).sql;
  const rankOrder = ranking.order === "asc" ? "ASC" : "DESC";
  // Lexical FTS is model-agnostic (issue #48300), but old databases may
  // already contain orphaned FTS rows from prior model-scoped cleanup.
  const liveChunkClause = ` AND EXISTS (SELECT 1 FROM memory_index_chunks c WHERE c.id = ${params.ftsTable}.id)`;
  const loadRows = (
    matchQuery: TextQuery | null,
    terms: string[],
  ): Array<MemorySearchRow & { rank: number | null }> => {
    const filter = buildSubstringFilter(terms, "text", params.matchAny);
    if (terms.length > 0) {
      registerSubstringSqlFunction(params.db, terms);
    }
    // Hidden rank lets FTS5 supply score order before LIMIT. Pin its mapping per
    // query so a persisted custom rank cannot change our default BM25 scores.
    const match = matchQuery ? fullText.match(index, matchQuery).compile(dialect) : undefined;
    const matchClause = match?.sql ?? "1=1";
    const columns = "id, path, source, start_line, end_line, text";
    const ranked = `SELECT ${columns}, ${rank} AS rank
      FROM ${params.ftsTable}
      WHERE ${matchClause}${liveChunkClause}${sourceFilter.sql}
      ORDER BY rank ${rankOrder} LIMIT +?`;
    // SQLite cannot combine MATCH with scalar OR predicates. Bound the BM25
    // leg first; substring-only trigram hits fill spare capacity without a score.
    const mixedOr = params.matchAny && matchQuery && terms.length > 0;
    const sql = mixedOr
      ? `WITH matches AS MATERIALIZED (${ranked}), substrings AS (
           SELECT ${columns}, NULL AS rank FROM ${params.ftsTable}
           WHERE 1=1${filter}${liveChunkClause}${sourceFilter.sql}
             AND id NOT IN (SELECT id FROM matches)
           LIMIT max(0, ? - (SELECT count(*) FROM matches))
         )
         SELECT * FROM matches UNION ALL SELECT * FROM substrings
         ORDER BY rank ${rankOrder} NULLS LAST`
      : `SELECT ${columns}, ${matchQuery ? rank : "NULL"} AS rank
         FROM ${params.ftsTable}
         WHERE ${matchClause}${filter}${liveChunkClause}${sourceFilter.sql}
         ${matchQuery ? `ORDER BY rank ${rankOrder}` : ""} LIMIT +?`;
    return executeSqliteQuerySync<MemorySearchRow & { rank: number | null }>(params.db, {
      compile: () =>
        CompiledQuery.raw(sql, [
          ...(match?.parameters ?? []),
          ...(mixedOr ? [...sourceFilter.params, params.limit] : []),
          ...terms,
          ...sourceFilter.params,
          params.limit,
        ]),
    }).rows;
  };

  const { rows, usedMatch } = loadKeywordRowsWithFallback(
    plan,
    loadRows,
    () => plan.tokens,
    "memory search: FTS5 MATCH failed, falling back to substring search",
  );

  const queryMatchers = params.boostFallbackRanking
    ? uniqueStrings(normalizeSearchTokens(params.query)).map((token) => ({
        word: literalSearchMatcher(token, true),
        substring: literalSearchMatcher(token),
      }))
    : [];
  return rows.map((row) => {
    // Substring fallback only confirms recall — it has no BM25 ranking, so
    // treating it as a perfect text match (textScore = 1) let weak substring
    // hits combine with vectorScore in the hybrid merge and produce spurious
    // finalScore = 1.0 for non-identical content. Score these as a zero text
    // signal so only the vector score contributes to contentScore; boost mode
    // still derives a lexicalBoost from query/text overlap via
    // scoreFallbackKeywordResult below.
    const textScore = usedMatch && row.rank !== null ? bm25RankToScore(row.rank) : 0;
    const score = params.boostFallbackRanking
      ? scoreFallbackKeywordResult({
          queryMatchers,
          path: row.path,
          text: row.text,
          ftsScore: textScore,
        })
      : textScore;
    return Object.assign(projectMemorySearchRow(row, params.snippetMaxChars, score), {
      textScore,
      hasBodyMatch: true as const,
    });
  });
}

export async function searchKeywordWithFallback(params: {
  db: DatabaseSync;
  body: Omit<Parameters<typeof searchKeyword>[0], "db" | "matchAny">;
  path: Omit<Parameters<typeof searchPathKeyword>[0], "db">;
}) {
  const runBody = (matchAny = false) =>
    searchKeyword({ ...params.body, db: params.db, matchAny })
      .then((rows) => ({ rows, error: undefined }))
      .catch((error: unknown) => ({ rows: [], error: formatErrorMessage(error) }));
  let body = await runBody();
  const path = await searchPathKeyword({ ...params.path, db: params.db })
    .then((rows) => ({ rows, error: undefined }))
    .catch((error: unknown) => ({ rows: [], error: formatErrorMessage(error) }));
  // A filename hit also preserves AND precision. Expand only an empty result.
  if (body.rows.length === 0 && path.rows.length === 0 && !body.error && !path.error) {
    body = await runBody(true);
  }
  return { body, path };
}

export async function searchPathKeyword(params: {
  db: DatabaseSync;
  pathFtsTable: string;
  query: string;
  exactPathLimit?: number;
  ftsTokenizer?: "unicode61" | "trigram";
  limit: number;
  snippetMaxChars: number;
  sourceFilter: MemorySourceFilter;
}): Promise<PathKeywordSearchResult[]> {
  if (params.limit <= 0) {
    return [];
  }
  const sourceFilter = buildSqliteMemorySourceFilter(params.sourceFilter, params.pathFtsTable);
  const snippet = resolveSnippetProjection("c.text", params.snippetMaxChars);
  const search = admitStoreSearch(params.db, {
    text: { path: { table: params.pathFtsTable, fields: ["path"] } },
  });
  if (!search.fullText) {
    throw new Error(search.diagnostics.join("; "));
  }
  const fullText = search.fullText;
  const index = search.text.path!;
  const dialect = getNodeSqliteKysely(params.db);
  const ranking = fullText.rank(index);
  const rank = ranking.value.compile(dialect).sql;
  const rankOrder = ranking.order === "asc" ? "ASC" : "DESC";
  const pathColumn = `${params.pathFtsTable}.path`;
  const pathPlans = planPathKeywordSearch({
    query: params.query,
    ftsTokenizer: params.ftsTokenizer,
  });
  const plan = pathPlans[0] ?? { query: params.query, matchQuery: null, substringTerms: [] };
  const planSubstringFilter = buildSubstringFilter(plan.substringTerms, pathColumn);
  registerSubstringSqlFunction(params.db, plan.substringTerms);
  const matchExactPath = prepareExactPathMatcher(params.query);
  // This reader consumes the query synchronously; substring plans can change
  // without replacing the original-query matcher.
  resolveSearchSqlFunctions(params.db).matchExactPath = matchExactPath;
  const projectPathRow = (
    row: MemorySearchRow,
    pathScore: number,
    exactPathSpecificity = matchExactPath(row.path),
  ): PathKeywordSearchResult =>
    Object.assign(projectMemorySearchRow(row, params.snippetMaxChars, pathScore), {
      textScore: 0 as const,
      pathScore,
      exactPathSpecificity,
      hasBodyMatch: false as const,
    });
  const projectFirstChunks = (
    paths: "exact_paths" | "retained_paths",
    score: "exact_path_specificity" | "rank",
    direction: "ASC" | "DESC",
  ) =>
    `SELECT c.id, ${paths}.path, ${paths}.source,\n` +
    `       c.start_line, c.end_line, ${snippet.sql} AS text, ${paths}.${score}\n` +
    `  FROM ${paths}\n` +
    `  CROSS JOIN memory_index_chunks c INDEXED BY sqlite_autoindex_memory_index_chunks_1 ON c.id = (\n` +
    `    SELECT candidate.id FROM memory_index_chunks candidate INDEXED BY idx_memory_index_chunks_path_source\n` +
    `     WHERE candidate.path = ${paths}.path\n` +
    `       AND candidate.source = ${paths}.source\n` +
    `     ORDER BY candidate.start_line, candidate.end_line, candidate.id\n` +
    `     LIMIT 1\n` +
    `  )\n` +
    ` ORDER BY ${paths}.${score} ${direction}, ${paths}.path ASC, ${paths}.source ASC`;
  const hasExplicitExactPathHeadroom = params.exactPathLimit !== undefined;
  const exactPathLimit = Math.max(0, Math.floor(params.exactPathLimit ?? params.limit));
  const exactCandidatePatterns = buildExactPathCandidatePatterns(params.query);
  type ExactPathRow = MemorySearchRow & {
    exact_path_specificity: ExactPathSpecificity;
  };
  // ASCII identifiers use FTS before suffix filtering; Unicode keeps LIKE.
  // Exclude empty files before LIMIT and keep one read snapshot. Both first-chunk
  // joins pin loop order and indexes so stale one-row statistics cannot cause scans.
  const loadExactRows = (useLexicalCandidates: boolean): ExactPathRow[] => {
    const qualifiedPatternClause = exactCandidatePatterns
      .map(() => `${pathColumn} LIKE (? || '') ESCAPE '\\'`)
      .join(" OR ");
    const match = plan.matchQuery
      ? fullText.match(index, plan.matchQuery).compile(dialect)
      : undefined;
    const candidateCtes = useLexicalCandidates
      ? `candidates AS MATERIALIZED (\n` +
        `  SELECT ${params.pathFtsTable}.path, ${params.pathFtsTable}.source\n` +
        `    FROM ${params.pathFtsTable}\n` +
        `   WHERE ${match?.sql ?? "1=1"}${planSubstringFilter}${sourceFilter.sql}\n` +
        `), pattern_candidates AS MATERIALIZED (\n` +
        `  SELECT path, source FROM candidates\n` +
        `   WHERE (${exactCandidatePatterns.map(() => "path LIKE (? || '') ESCAPE '\\'").join(" OR ")})\n` +
        `)`
      : `pattern_candidates AS MATERIALIZED (\n` +
        `  SELECT ${params.pathFtsTable}.path, ${params.pathFtsTable}.source\n` +
        `    FROM ${params.pathFtsTable}\n` +
        `   WHERE (${qualifiedPatternClause})${sourceFilter.sql}\n` +
        `)`;
    const candidateParams = useLexicalCandidates
      ? [
          ...(match?.parameters ?? []),
          ...plan.substringTerms,
          ...sourceFilter.params,
          ...exactCandidatePatterns,
        ]
      : [...exactCandidatePatterns, ...sourceFilter.params];
    const statement =
      `WITH ${candidateCtes}, scored_paths AS MATERIALIZED (\n` +
      `  SELECT path, source,\n` +
      `         ${EXACT_PATH_SPECIFICITY_SQL_FUNCTION}(path) AS exact_path_specificity\n` +
      `    FROM pattern_candidates\n` +
      `), exact_paths AS MATERIALIZED (\n` +
      `  SELECT path, source, exact_path_specificity FROM scored_paths\n` +
      `   WHERE exact_path_specificity > 0\n` +
      `     AND EXISTS (SELECT 1 FROM memory_index_chunks live\n` +
      `                  WHERE live.path = scored_paths.path\n` +
      `                    AND live.source = scored_paths.source)\n` +
      `   ORDER BY exact_path_specificity DESC, path ASC, source ASC\n` +
      `   LIMIT +?\n` +
      `)\n` +
      projectFirstChunks("exact_paths", "exact_path_specificity", "DESC");
    return executeSqliteQuerySync<ExactPathRow>(params.db, {
      compile: () =>
        CompiledQuery.raw(statement, [...candidateParams, exactPathLimit, ...snippet.params]),
    }).rows;
  };
  const useLexicalExactCandidates =
    isAscii(params.query) && (plan.matchQuery !== null || plan.substringTerms.length > 0);
  let exactRows: ExactPathRow[] = [];
  if (exactCandidatePatterns.length > 0 && exactPathLimit > 0) {
    try {
      exactRows = loadExactRows(useLexicalExactCandidates);
    } catch (err) {
      if (!useLexicalExactCandidates) {
        throw err;
      }
      // Tokenizer-specific MATCH failures must not suppress exact path recall.
      exactRows = loadExactRows(false);
    }
  }
  const exactResults = exactRows.map((row) => projectPathRow(row, 0, row.exact_path_specificity));
  if (!pathPlans.some((entry) => entry.matchQuery || entry.substringTerms.length > 0)) {
    return exactResults;
  }
  type PathLexicalRow = MemorySearchRow & { rank: number };
  const loadFilteredLexicalRows = (
    matchQuery: TextQuery | null,
    terms: string[],
    specificity: "exact" | "non-exact",
    resultLimit: number,
  ) => {
    const filter = buildSubstringFilter(terms, pathColumn);
    const match = matchQuery ? fullText.match(index, matchQuery).compile(dialect) : undefined;
    const specificityOperator = specificity === "exact" ? ">" : "=";
    const qualifiedSpecificityClause = ` AND ${EXACT_PATH_SPECIFICITY_SQL_FUNCTION}(${pathColumn}) ${specificityOperator} 0`;
    const queryParams = [...(match?.parameters ?? []), ...terms, ...sourceFilter.params];
    // Filter empty sources before LIMIT, then resolve first chunks only for the
    // retained paths. Keep both phases in the same statement's read snapshot.
    const statement =
      `WITH retained_paths AS MATERIALIZED (\n` +
      `  SELECT ${params.pathFtsTable}.path, ${params.pathFtsTable}.source,\n` +
      `         ${matchQuery ? rank : "0"} AS rank\n` +
      `    FROM ${params.pathFtsTable}\n` +
      `   WHERE ${match?.sql ?? "1=1"}${filter}${sourceFilter.sql}${qualifiedSpecificityClause}\n` +
      `     AND EXISTS (SELECT 1 FROM memory_index_chunks live\n` +
      `                  WHERE live.path = ${params.pathFtsTable}.path\n` +
      `                    AND live.source = ${params.pathFtsTable}.source)\n` +
      `   ORDER BY rank ${rankOrder}, ${params.pathFtsTable}.path ASC, ${params.pathFtsTable}.source ASC\n` +
      `   LIMIT +?\n` +
      `)\n` +
      projectFirstChunks("retained_paths", "rank", rankOrder);
    return executeSqliteQuerySync<PathLexicalRow>(params.db, {
      compile: () => CompiledQuery.raw(statement, [...queryParams, resultLimit, ...snippet.params]),
    }).rows;
  };
  const loadLexicalRows = (lexicalPlan: (typeof pathPlans)[number]) => {
    // Partition before LIMIT so an exact-filename flood cannot consume the
    // normal lexical budget reserved for partial path matches.
    const loadPartitions = (matchQuery: TextQuery | null, terms: string[]) => {
      registerSubstringSqlFunction(params.db, terms);
      return [
        ...(exactPathLimit > 0
          ? loadFilteredLexicalRows(matchQuery, terms, "exact", exactPathLimit)
          : []),
        ...loadFilteredLexicalRows(matchQuery, terms, "non-exact", params.limit),
      ];
    };
    return loadKeywordRowsWithFallback(
      lexicalPlan,
      loadPartitions,
      () => tokenizeFtsQuery(lexicalPlan.query, true),
      "memory search: path FTS5 MATCH failed, falling back to substring search",
    );
  };

  const lexicalById = new Map<string, PathKeywordSearchResult>();
  for (const lexicalPlan of pathPlans) {
    if (!lexicalPlan.matchQuery && lexicalPlan.substringTerms.length === 0) {
      continue;
    }
    const { rows, usedMatch } = loadLexicalRows(lexicalPlan);
    for (const row of rows) {
      const pathScore = usedMatch ? bm25RankToScore(row.rank) : 1;
      const result = projectPathRow(row, pathScore);
      const existing = lexicalById.get(result.id);
      if (!existing) {
        lexicalById.set(result.id, result);
        continue;
      }
      mergePathKeywordScores(existing, result);
    }
  }

  const byId = new Map(exactResults.map((entry) => [entry.id, entry]));
  let nonExactCount = 0;
  for (const entry of [...lexicalById.values()].toSorted(comparePathKeywordSearchResults)) {
    const exact = byId.get(entry.id);
    if (entry.exactPathSpecificity > 0) {
      if (!exact) {
        continue;
      }
      mergePathKeywordScores(exact, entry);
      continue;
    }
    if (nonExactCount >= params.limit) {
      continue;
    }
    byId.set(entry.id, entry);
    nonExactCount += 1;
  }
  // Exact filenames get bounded headroom only when the manager explicitly
  // requests it; otherwise `limit` remains the total-result contract.
  const resultLimit = hasExplicitExactPathHeadroom ? exactPathLimit + params.limit : params.limit;
  return [...byId.values()].toSorted(comparePathKeywordSearchResults).slice(0, resultLimit);
}
