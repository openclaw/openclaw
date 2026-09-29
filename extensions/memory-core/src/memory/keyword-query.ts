import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";

function quoteMatchTerm(term: string): string {
  return `"${term.replaceAll('"', "")}"`;
}

export function buildFtsQuery(raw: string): string | null {
  const terms = normalizeStringEntries(raw.match(/[\p{L}\p{N}_]+/gu) ?? []);
  if (terms.length === 0) {
    return null;
  }
  // Natural-language questions rarely repeat every token in the answer chunk.
  // OR the terms and let BM25 rank by the rare ones (issue #160839); callers
  // pair this with buildStrictFtsQuery to keep complete matches in their own
  // tier ahead of partial hits before the candidate limit applies.
  return terms.map(quoteMatchTerm).join(" OR ");
}

export function buildStrictFtsQuery(raw: string): string | null {
  // Strict AND matching: filename search requires every token so an extension
  // like "md" cannot match unrelated ".md" paths, and body search uses this as
  // the complete-match tier above OR recall.
  return buildMatchQueryFromTerms(normalizeStringEntries(raw.match(/[\p{L}\p{N}_]+/gu) ?? []));
}

export function buildMatchQueryFromTerms(terms: string[]): string | null {
  if (terms.length === 0) {
    return null;
  }
  return terms.map(quoteMatchTerm).join(" AND ");
}

export function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) {
    return 1 / (1 + 999);
  }
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}
