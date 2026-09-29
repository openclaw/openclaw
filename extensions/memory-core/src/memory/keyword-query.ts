import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";

function quoteMatchTerm(term: string): string {
  return `"${term.replaceAll('"', "")}"`;
}

export function buildFtsQuery(raw: string): string | null {
  const terms = normalizeStringEntries(raw.match(/[\p{L}\p{N}_]+/gu) ?? []);
  if (terms.length === 0) {
    return null;
  }
  const quoted = terms.map(quoteMatchTerm);
  if (quoted.length === 1) {
    return quoted[0] ?? null;
  }
  // Natural-language questions rarely repeat every token in the answer chunk.
  // OR the terms and let BM25 rank by the rare ones (issue #160839); prepend
  // the full-coverage conjunction so a note matching every token still earns
  // each term's score twice and stays ahead of partial matches.
  return `${quoted.join(" AND ")} OR ${quoted.join(" OR ")}`;
}

export function buildPathFtsQuery(raw: string): string | null {
  // Filename search keeps strict token matching: an OR-joined extension token
  // such as "md" would match every unrelated ".md" path.
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
