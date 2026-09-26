import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";

export function buildFtsQuery(raw: string): string | null {
  return buildMatchQueryFromTerms(normalizeStringEntries(raw.match(/[\p{L}\p{N}_]+/gu) ?? []));
}

export function buildMatchQueryFromTerms(terms: string[]): string | null {
  if (terms.length === 0) {
    return null;
  }
  return terms.map((term) => `"${term.replaceAll('"', "")}"`).join(" AND ");
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
