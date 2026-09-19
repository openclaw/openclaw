import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";

export function tokenizeFtsQuery(raw: string): string[] {
  return normalizeStringEntries(raw.match(/[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*/gu) ?? []);
}

export function buildFtsQuery(raw: string): string | null {
  return buildMatchQueryFromTerms(tokenizeFtsQuery(raw), true);
}

function canonicalTermForms(term: string): string[] {
  return [...new Set([term, term.normalize("NFC"), term.normalize("NFD")])];
}

export function buildMatchQueryFromTerms(
  terms: string[],
  canonicalVariants = false,
): string | null {
  if (terms.length === 0) {
    return null;
  }
  const quoted = terms.map((term) => {
    const forms = canonicalVariants ? canonicalTermForms(term) : [term];
    const alternatives = forms.map((form) => `"${form.replaceAll('"', "")}"`);
    // Alternatives belong to each word: one document can mix NFC and NFD words.
    return alternatives.length === 1 ? alternatives[0] : `(${alternatives.join(" OR ")})`;
  });
  return quoted.join(" AND ");
}

export function planKeywordSearch(params: {
  query: string;
  ftsTokenizer?: "unicode61" | "trigram";
  buildFtsQuery: (raw: string) => string | null;
  includeCombiningMarks?: boolean;
  canonicalVariants?: boolean;
}): { matchQuery: string | null; substringTerms: string[] } {
  if (params.ftsTokenizer !== "trigram") {
    return { matchQuery: params.buildFtsQuery(params.query), substringTerms: [] };
  }
  const tokens = params.includeCombiningMarks
    ? normalizeStringEntries(params.query.match(/[\p{L}\p{M}\p{N}_]+/gu) ?? [])
    : tokenizeFtsQuery(params.query);
  const matchTerms: string[] = [];
  const substringTerms: string[] = [];
  for (const token of tokens) {
    const forms = params.canonicalVariants ? canonicalTermForms(token) : [token];
    // MATCH cannot find fewer than three code points. A decomposed spelling
    // must not hide a short composed form from the normalized substring owner.
    if (forms.some((form) => Array.from(form).length < 3)) {
      substringTerms.push(token);
    } else {
      matchTerms.push(token);
    }
  }
  return {
    matchQuery: buildMatchQueryFromTerms(matchTerms, params.canonicalVariants),
    substringTerms,
  };
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
