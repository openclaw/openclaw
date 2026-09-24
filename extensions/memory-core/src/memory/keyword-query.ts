import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";

type FtsCanonicalTokenizer = "unicode61" | "trigram";

export type FtsQueryBuilder = (
  raw: string,
  canonicalTokenizer?: FtsCanonicalTokenizer,
) => string | null;

export function tokenizeFtsQuery(raw: string): string[] {
  return normalizeStringEntries(raw.match(/[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*/gu) ?? []);
}

export function buildFtsQuery(
  raw: string,
  canonicalTokenizer?: FtsCanonicalTokenizer,
): string | null {
  return buildMatchQueryFromTerms(tokenizeFtsQuery(raw), canonicalTokenizer);
}

// unicode61 remove_diacritics=1 folds a single mark when its base case-folds to
// ASCII Latin, plus one-code-point canonical aliases. Preserve all other forms.
function hasCompatibilityAlias(term: string): boolean {
  return Array.from(term).some(
    (character) =>
      character !== character.normalize("NFC") &&
      character.normalize("NFC") === character.normalize("NFD"),
  );
}

function unicode61FoldsCanonicalForms(term: string): boolean {
  if (hasCompatibilityAlias(term)) {
    return false;
  }
  return Array.from(term.normalize("NFC")).every((character) => {
    const decomposed = Array.from(character.normalize("NFD"));
    const base = decomposed[0];
    if (!base) {
      return false;
    }
    const foldedBase = base.toUpperCase().toLowerCase();
    if (decomposed.length === 1) {
      return character.toUpperCase().toLowerCase() === foldedBase;
    }
    return (
      decomposed.length === 2 && /\p{M}/u.test(decomposed[1] ?? "") && /^[a-z]$/u.test(foldedBase)
    );
  });
}

function unicode61TokenizerKey(term: string): string {
  if (hasCompatibilityAlias(term)) {
    return `compat:${term}`;
  }
  let key = "";
  let followsAsciiBase = false;
  for (const character of term) {
    const decomposed = Array.from(character.normalize("NFD"));
    const base = decomposed[0];
    const foldedBase = base?.toUpperCase().toLowerCase();
    if (
      decomposed.length === 2 &&
      /\p{M}/u.test(decomposed[1] ?? "") &&
      foldedBase &&
      /^[a-z]$/u.test(foldedBase)
    ) {
      key += foldedBase;
      followsAsciiBase = true;
      continue;
    }
    if (/\p{M}/u.test(character) && followsAsciiBase) {
      continue;
    }
    const folded = character.toUpperCase().toLowerCase();
    key += folded;
    followsAsciiBase = /^[a-z]$/u.test(folded);
  }
  return key;
}

function canonicalTermForms(term: string, tokenizer?: FtsCanonicalTokenizer): string[] {
  if (!tokenizer) {
    return [term];
  }
  const seen = new Set<string>();
  return [term, term.normalize("NFC"), term.normalize("NFD")].filter((form) => {
    const key = tokenizer === "unicode61" ? unicode61TokenizerKey(form) : form;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function buildMatchQueryFromTerms(
  terms: string[],
  canonicalTokenizer?: FtsCanonicalTokenizer,
): string | null {
  if (terms.length === 0) {
    return null;
  }
  const quoted = terms.map((term) => {
    const forms =
      canonicalTokenizer === "unicode61" && unicode61FoldsCanonicalForms(term)
        ? [term]
        : canonicalTermForms(term, canonicalTokenizer);
    const alternatives = forms.map((form) => `"${form.replaceAll('"', "")}"`);
    // Alternatives belong to each word: one document can mix NFC and NFD words.
    return alternatives.length === 1 ? alternatives[0] : `(${alternatives.join(" OR ")})`;
  });
  return quoted.join(" AND ");
}

export function planKeywordSearch(params: {
  query: string;
  ftsTokenizer?: "unicode61" | "trigram";
  buildFtsQuery: FtsQueryBuilder;
  includeCombiningMarks?: boolean;
  canonicalVariants?: boolean;
}): { matchQuery: string | null; substringTerms: string[] } {
  const canonicalTokenizer = params.canonicalVariants
    ? (params.ftsTokenizer ?? "unicode61")
    : undefined;
  if (params.ftsTokenizer !== "trigram") {
    const matchQuery = params.buildFtsQuery(params.query, canonicalTokenizer);
    return { matchQuery, substringTerms: [] };
  }
  const tokens = params.includeCombiningMarks
    ? normalizeStringEntries(params.query.match(/[\p{L}\p{M}\p{N}_]+/gu) ?? [])
    : tokenizeFtsQuery(params.query);
  const matchTerms: string[] = [];
  const substringTerms: string[] = [];
  for (const token of tokens) {
    const forms = canonicalTermForms(token, canonicalTokenizer);
    // MATCH cannot find fewer than three code points. A decomposed spelling
    // must not hide a short composed form from the normalized substring owner.
    if (forms.some((form) => Array.from(form).length < 3)) {
      substringTerms.push(token);
    } else {
      matchTerms.push(token);
    }
  }
  return {
    matchQuery: buildMatchQueryFromTerms(matchTerms, canonicalTokenizer),
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
