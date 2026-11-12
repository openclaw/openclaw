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
