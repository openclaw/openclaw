/**
 * Han bigram helpers for the optional CJK companion index.
 *
 * SQLite FTS5 ships exactly four tokenizers (unicode61, ascii, porter,
 * trigram) and `node:sqlite` cannot register a custom `fts5_api` tokenizer,
 * so a "bigram" tokenizer option cannot exist in this runtime. The companion
 * index instead stores a bigram-encoded copy of the chunk text in a table
 * that keeps the `unicode61` tokenizer: every Han run becomes its overlapping
 * character bigrams, so a two-character query becomes an indexable and
 * BM25-rankable token.
 *
 * The trigram tokenizer cannot cover the same ground: FTS5 never matches a
 * full-text query shorter than three characters, so a two-character Han term
 * cannot be expressed as a trigram query or a trigram prefix query.
 *
 * Japanese kana and Korean syllables keep their existing segmentation paths.
 */

// Han ideographs: CJK Unified Ideographs and Extension A.
const HAN_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;
const HAN_ONLY_RE = /^[\u3400-\u4dbf\u4e00-\u9fff]+$/u;

/** True when the term is made only of Han ideographs. */
export function isHanTerm(term: string): boolean {
  return HAN_ONLY_RE.test(term);
}

/**
 * Replace every Han run with its overlapping character bigrams.
 *
 * Non-Han text is left untouched so the same table still serves ASCII terms,
 * and bigrams are separated by spaces so `unicode61` tokenizes them as
 * individual tokens.
 */
export function encodeHanBigrams(text: string): string {
  return text.replace(HAN_RUN_RE, (run) => {
    if (run.length < 2) {
      // A lone ideograph has no bigram; keep it as one token so the index side
      // and the query side stay in sync.
      return ` ${run} `;
    }
    const bigrams: string[] = [];
    for (let index = 1; index < run.length; index += 1) {
      bigrams.push(run.slice(index - 1, index + 1));
    }
    return ` ${bigrams.join(" ")} `;
  });
}

/**
 * Build the FTS5 phrase that matches one term in the companion index.
 *
 * The phrase reuses the index-side encoding, so the term matches exactly when
 * it appears contiguously in the source text.
 */
export function buildHanBigramPhrase(term: string): string | null {
  const tokens = encodeHanBigrams(term)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replaceAll('"', ""));
  if (tokens.length === 0) {
    return null;
  }
  return `"${tokens.join(" ")}"`;
}

/** Combine per-term phrases into one FTS5 match expression. */
export function buildHanBigramMatchQuery(
  terms: readonly string[],
  matchAny = false,
): string | null {
  const phrases: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    const phrase = buildHanBigramPhrase(term);
    if (!phrase || seen.has(phrase)) {
      continue;
    }
    seen.add(phrase);
    phrases.push(phrase);
  }
  return phrases.length > 0 ? phrases.join(matchAny ? " OR " : " AND ") : null;
}

/** Construct SQL for companion index queries with optional OR recovery. */
export function buildCompanionSearchSql(params: {
  cjkTable: string;
  filter: string;
  sourceFilterSql: string;
  mixedOr: boolean;
}): string {
  if (params.mixedOr) {
    return (
      `WITH hits AS (\n` +
      `  SELECT "rowid" AS chunk_rowid, rank FROM ${params.cjkTable}\n` +
      `   WHERE ${params.cjkTable} MATCH ? AND ${params.cjkTable}.rank MATCH 'bm25()'\n` +
      `), matches AS (\n` +
      `  SELECT c.id, c.path, c.source, c.start_line, c.end_line, c.text, hits.rank AS rank\n` +
      `    FROM hits JOIN memory_index_chunks c ON c.chunk_rowid = hits.chunk_rowid\n` +
      `   WHERE 1=1${params.sourceFilterSql}\n` +
      `   ORDER BY hits.rank ASC\n` +
      `   LIMIT ?\n` +
      `), substrings AS (\n` +
      `  SELECT c.id, c.path, c.source, c.start_line, c.end_line, c.text, NULL AS rank\n` +
      `    FROM memory_index_chunks c\n` +
      `   WHERE 1=1${params.filter}${params.sourceFilterSql}\n` +
      `     AND c.id NOT IN (SELECT id FROM matches)\n` +
      `   LIMIT max(0, ? - (SELECT count(*) FROM matches))\n` +
      `)\n` +
      `SELECT * FROM matches UNION ALL SELECT * FROM substrings\n` +
      `ORDER BY rank ASC NULLS LAST\n` +
      `LIMIT ?`
    );
  }
  return (
    `WITH hits AS (\n` +
    `  SELECT "rowid" AS chunk_rowid, rank FROM ${params.cjkTable}\n` +
    `   WHERE ${params.cjkTable} MATCH ? AND ${params.cjkTable}.rank MATCH 'bm25()'\n` +
    `)\n` +
    `SELECT c.id, c.path, c.source, c.start_line, c.end_line, c.text,\n` +
    `       hits.rank AS rank\n` +
    `  FROM hits JOIN memory_index_chunks c ON c.chunk_rowid = hits.chunk_rowid\n` +
    ` WHERE 1=1${params.filter}${params.sourceFilterSql}\n` +
    ` ORDER BY hits.rank ASC\n` +
    ` LIMIT ?`
  );
}
