import type { DatabaseSync } from "node:sqlite";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { extractKeywords } from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import {
  cosineSimilarity,
  parseEmbedding,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);
const FTS_QUERY_TOKEN_RE = /[\p{L}\p{N}_]+/gu;
const SHORT_CJK_TRIGRAM_RE = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u3131-\u3163]/u;

/**
 * Extract a relevant snippet window around the query match in the text.
 * If the query is found, returns a window centered on the match.
 * Otherwise falls back to the beginning of the text.
 */
function extractRelevantSnippet(
  text: string,
  query: string,
  maxChars: number,
): { snippet: string; offsetLines: number; snippetLines: number; anchorFound: boolean } {
  if (text.length <= maxChars) {
    return {
      snippet: text,
      offsetLines: 0,
      snippetLines: (text.match(/\n/g) || []).length,
      anchorFound: true,
    };
  }

  // Use the same tokenizer as the search engine so CJK terms and
  // conversational queries produce correct anchor terms.
  const lowerText = text.toLowerCase();
  const queryTerms = extractKeywords(query).toSorted((a, b) => b.length - a.length);

  let matchIndex = -1;

  // Find the first matching term
  for (const term of queryTerms) {
    const idx = lowerText.indexOf(term);
    if (idx !== -1) {
      matchIndex = idx;
      break;
    }
  }

  // If no match found, return the full chunk text rather than truncating to
  // the beginning.  Semantic/vector matches often don't share literal keywords
  // with the query, so trimming from the start would discard the relevant
  // section when it appears later in the chunk.
  if (matchIndex === -1) {
    return {
      snippet: text,
      offsetLines: 0,
      snippetLines: (text.match(/\n/g) || []).length,
      anchorFound: false,
    };
  }

  // Calculate window start, trying to center the match
  const halfWindow = Math.floor(maxChars / 2);
  let windowStart = Math.max(0, matchIndex - halfWindow);
  let windowEnd = Math.min(text.length, windowStart + maxChars);

  // Adjust if we're near the end
  if (windowEnd === text.length && windowEnd - windowStart < maxChars) {
    windowStart = Math.max(0, windowEnd - maxChars);
  }

  // Try to start at a line boundary for cleaner output
  if (windowStart > 0) {
    const lineStart = text.lastIndexOf("\n", windowStart);
    if (lineStart !== -1 && windowStart - lineStart < 100) {
      windowStart = lineStart + 1;
      // Recalculate windowEnd to maintain maxChars length after snap
      windowEnd = Math.min(text.length, windowStart + maxChars);
    }
  }

  // Count lines before the window to adjust startLine/endLine display
  const textBeforeWindow = text.substring(0, windowStart);
  const offsetLines = (textBeforeWindow.match(/\n/g) || []).length;

  const snippet = truncateUtf16Safe(text.substring(windowStart, windowEnd), maxChars);
  const snippetLines = (snippet.match(/\n/g) || []).length;
  return { snippet, offsetLines, snippetLines, anchorFound: true };
}

export type SearchSource = string;

export type SearchRowResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: SearchSource;
};

function normalizeSearchTokens(raw: string): string[] {
  return (
    raw
      .match(FTS_QUERY_TOKEN_RE)
      ?.map((token) => token.trim().toLowerCase())
      .filter(Boolean) ?? []
  );
}

function scoreFallbackKeywordResult(params: {
  query: string;
  path: string;
  text: string;
  ftsScore: number;
}): number {
  const queryTokens = [...new Set(normalizeSearchTokens(params.query))];
  if (queryTokens.length === 0) {
    return params.ftsScore;
  }

  const textTokens = normalizeSearchTokens(params.text);
  const textTokenSet = new Set(textTokens);
  const pathLower = params.path.toLowerCase();
  const overlap = queryTokens.filter((token) => textTokenSet.has(token)).length;
  const uniqueQueryOverlap = overlap / Math.max(new Set(queryTokens).size, 1);
  const density = overlap / Math.max(textTokenSet.size, 1);
  const pathBoost = queryTokens.reduce(
    (score, token) => score + (pathLower.includes(token) ? 0.18 : 0),
    0,
  );
  const textLengthBoost = Math.min(params.text.length / 160, 0.18);

  const lexicalBoost = uniqueQueryOverlap * 0.45 + density * 0.2 + pathBoost + textLengthBoost;
  return Math.min(1, params.ftsScore + lexicalBoost);
}

function escapeLikePattern(term: string): string {
  return term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function buildMatchQueryFromTerms(terms: string[]): string | null {
  if (terms.length === 0) {
    return null;
  }
  const quoted = terms.map((term) => `"${term.replaceAll('"', "")}"`);
  return quoted.join(" AND ");
}

function planKeywordSearch(params: {
  query: string;
  ftsTokenizer?: "unicode61" | "trigram";
  buildFtsQuery: (raw: string) => string | null;
}): { matchQuery: string | null; substringTerms: string[] } {
  if (params.ftsTokenizer !== "trigram") {
    return {
      matchQuery: params.buildFtsQuery(params.query),
      substringTerms: [],
    };
  }

  const tokens =
    params.query
      .match(FTS_QUERY_TOKEN_RE)
      ?.map((token) => token.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) {
    return { matchQuery: null, substringTerms: [] };
  }

  const matchTerms: string[] = [];
  const substringTerms: string[] = [];
  for (const token of tokens) {
    if (SHORT_CJK_TRIGRAM_RE.test(token) && Array.from(token).length < 3) {
      substringTerms.push(token);
      continue;
    }
    matchTerms.push(token);
  }

  return {
    matchQuery: buildMatchQueryFromTerms(matchTerms),
    substringTerms,
  };
}

export async function searchVector(params: {
  db: DatabaseSync;
  vectorTable: string;
  providerModel: string;
  queryVec: number[];
  queryText: string;
  limit: number;
  snippetMaxChars: number;
  ensureVectorReady: (dimensions: number) => Promise<boolean>;
  sourceFilterVec: { sql: string; params: SearchSource[] };
  sourceFilterChunks: { sql: string; params: SearchSource[] };
}): Promise<SearchRowResult[]> {
  if (params.queryVec.length === 0 || params.limit <= 0) {
    return [];
  }
  if (await params.ensureVectorReady(params.queryVec.length)) {
    const rows = params.db
      .prepare(
        `SELECT c.id, c.path, c.start_line, c.end_line, c.text,\n` +
          `       c.source,\n` +
          `       vec_distance_cosine(v.embedding, ?) AS dist\n` +
          `  FROM ${params.vectorTable} v\n` +
          `  JOIN chunks c ON c.id = v.id\n` +
          ` WHERE c.model = ?${params.sourceFilterVec.sql}\n` +
          ` ORDER BY dist ASC\n` +
          ` LIMIT ?`,
      )
      .all(
        vectorToBlob(params.queryVec),
        params.providerModel,
        ...params.sourceFilterVec.params,
        params.limit,
      ) as Array<{
      id: string;
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      source: SearchSource;
      dist: number;
    }>;
    return rows.map((row) => {
      const { snippet, offsetLines, snippetLines, anchorFound } = extractRelevantSnippet(
        row.text,
        params.queryText,
        params.snippetMaxChars,
      );
      // Session chunks use sparse remapped line numbers (from JSONL lineMap)
      // that are not contiguous, so applying a text-based offset can produce
      // synthetic line numbers that don't exist.  Keep original range for sessions.
      const isSessionSource = row.source === "sessions";
      const adjustedStart = isSessionSource
        ? row.start_line
        : Math.min(row.start_line + offsetLines, row.end_line);
      // When no anchor was found the snippet is a fallback window; preserve
      // the chunk's full line span so semantic matches later in the text are
      // not excluded.  Always clamp to the chunk's original end_line to
      // guard against synthetic newlines inflating the count.
      const endLine =
        !isSessionSource && anchorFound
          ? Math.min(adjustedStart + snippetLines, row.end_line)
          : row.end_line;
      return {
        id: row.id,
        path: row.path,
        startLine: adjustedStart,
        endLine,
        score: 1 - row.dist,
        snippet,
        source: row.source,
      };
    });
  }

  const candidates = listChunks({
    db: params.db,
    providerModel: params.providerModel,
    sourceFilter: params.sourceFilterChunks,
  });
  const scored = candidates
    .map((chunk) => ({
      chunk,
      score: cosineSimilarity(params.queryVec, chunk.embedding),
    }))
    .filter((entry) => Number.isFinite(entry.score));
  return scored
    .toSorted((a, b) => b.score - a.score)
    .slice(0, params.limit)
    .map((entry) => {
      const { snippet, offsetLines, snippetLines, anchorFound } = extractRelevantSnippet(
        entry.chunk.text,
        params.queryText,
        params.snippetMaxChars,
      );
      // Session chunks use sparse remapped line numbers; skip offset adjustment.
      const isSessionSource = entry.chunk.source === "sessions";
      const adjustedStart = isSessionSource
        ? entry.chunk.startLine
        : Math.min(entry.chunk.startLine + offsetLines, entry.chunk.endLine);
      const endLine =
        !isSessionSource && anchorFound
          ? Math.min(adjustedStart + snippetLines, entry.chunk.endLine)
          : entry.chunk.endLine;
      return {
        id: entry.chunk.id,
        path: entry.chunk.path,
        startLine: adjustedStart,
        endLine,
        score: entry.score,
        snippet,
        source: entry.chunk.source,
      };
    });
}

export function listChunks(params: {
  db: DatabaseSync;
  providerModel: string;
  sourceFilter: { sql: string; params: SearchSource[] };
}): Array<{
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  embedding: number[];
  source: SearchSource;
}> {
  const rows = params.db
    .prepare(
      `SELECT id, path, start_line, end_line, text, embedding, source\n` +
        `  FROM chunks\n` +
        ` WHERE model = ?${params.sourceFilter.sql}`,
    )
    .all(params.providerModel, ...params.sourceFilter.params) as Array<{
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
    embedding: string;
    source: SearchSource;
  }>;

  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    text: row.text,
    embedding: parseEmbedding(row.embedding),
    source: row.source,
  }));
}

export async function searchKeyword(params: {
  db: DatabaseSync;
  ftsTable: string;
  providerModel: string | undefined;
  query: string;
  ftsTokenizer?: "unicode61" | "trigram";
  limit: number;
  snippetMaxChars: number;
  sourceFilter: { sql: string; params: SearchSource[] };
  buildFtsQuery: (raw: string) => string | null;
  bm25RankToScore: (rank: number) => number;
  boostFallbackRanking?: boolean;
}): Promise<Array<SearchRowResult & { textScore: number }>> {
  if (params.limit <= 0) {
    return [];
  }
  const plan = planKeywordSearch({
    query: params.query,
    ftsTokenizer: params.ftsTokenizer,
    buildFtsQuery: params.buildFtsQuery,
  });
  if (!plan.matchQuery && plan.substringTerms.length === 0) {
    return [];
  }

  // When providerModel is undefined (FTS-only mode), search all models
  const modelClause = params.providerModel ? " AND model = ?" : "";
  const modelParams = params.providerModel ? [params.providerModel] : [];
  const substringClause = plan.substringTerms.map(() => " AND text LIKE ? ESCAPE '\\'").join("");
  const substringParams = plan.substringTerms.map((term) => `%${escapeLikePattern(term)}%`);
  const whereClause = plan.matchQuery
    ? `${params.ftsTable} MATCH ?${substringClause}${modelClause}${params.sourceFilter.sql}`
    : `1=1${substringClause}${modelClause}${params.sourceFilter.sql}`;
  const queryParams = [
    ...(plan.matchQuery ? [plan.matchQuery] : []),
    ...substringParams,
    ...modelParams,
    ...params.sourceFilter.params,
    params.limit,
  ];
  const rankExpression = plan.matchQuery ? `bm25(${params.ftsTable})` : "0";

  const rows = params.db
    .prepare(
      `SELECT id, path, source, start_line, end_line, text,\n` +
        `       ${rankExpression} AS rank\n` +
        `  FROM ${params.ftsTable}\n` +
        ` WHERE ${whereClause}\n` +
        ` ORDER BY rank ASC\n` +
        ` LIMIT ?`,
    )
    .all(...queryParams) as Array<{
    id: string;
    path: string;
    source: SearchSource;
    start_line: number;
    end_line: number;
    text: string;
    rank: number;
  }>;

  return rows.map((row) => {
    const textScore = plan.matchQuery ? params.bm25RankToScore(row.rank) : 1;
    const score = params.boostFallbackRanking
      ? scoreFallbackKeywordResult({
          query: params.query,
          path: row.path,
          text: row.text,
          ftsScore: textScore,
        })
      : textScore;
    const { snippet, offsetLines, snippetLines, anchorFound } = extractRelevantSnippet(
      row.text,
      params.query,
      params.snippetMaxChars,
    );
    // Session chunks use sparse remapped line numbers; skip offset adjustment.
    const isSessionSource = row.source === "sessions";
    const adjustedStart = isSessionSource
      ? row.start_line
      : Math.min(row.start_line + offsetLines, row.end_line);
    const endLine =
      !isSessionSource && anchorFound
        ? Math.min(adjustedStart + snippetLines, row.end_line)
        : row.end_line;
    return {
      id: row.id,
      path: row.path,
      startLine: adjustedStart,
      endLine,
      score,
      textScore,
      snippet,
      source: row.source,
    };
  });
}
