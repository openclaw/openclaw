import { extractKeywords } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { normalizeStringEntries, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";

type FtsCanonicalTokenizer = "unicode61" | "trigram";

export function tokenizeFtsQuery(raw: string, includeLeadingMarks = false): string[] {
  const pattern = includeLeadingMarks
    ? /[\p{L}\p{M}\p{N}_]+/gu
    : /[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*/gu;
  return normalizeStringEntries(raw.match(pattern) ?? []);
}

function simpleCaseFold(character: string): string {
  const upper = character.toUpperCase();
  const folded = Array.from(upper).length === 1 ? upper.toLowerCase() : character.toLowerCase();
  // SQLite folds one code point to one code point. Full case expansions such
  // as Greek dialytika/tonos must not erase a distinct canonical query form.
  return Array.from(folded).length === 1 ? folded : character;
}

// Match sqlite3Fts5UnicodeIsdiacritic in SQLite ext/fts5/fts5_unicode2.c.
// Other Unicode 6.1 marks are separators: dropping them can discard a necessary
// canonical alternative even though MATCH succeeds without finding a row.
const UNICODE61_DIACRITIC =
  /[\u0300-\u0304\u0306-\u030c\u030f\u0311\u031b\u0323-\u0328\u032d\u032e\u0330\u0331]/u;

// Unicode 6.1 M categories from SQLite ext/fts5/fts5_unicode2.c. Newer marks
// are token characters to unicode61, so JavaScript Unicode categories cannot
// decide which canonical query alternatives are equivalent.
const UNICODE61_MARK = new RegExp(
  "[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u05bf\u05c1-\u05c2\u05c4-\u05c5\u05c7\u0610-\u061a" +
    "\u064b-\u065f\u0670\u06d6-\u06dc\u06df-\u06e4\u06e7-\u06e8\u06ea-\u06ed\u0711\u0730-\u074a" +
    "\u07a6-\u07b0\u07eb-\u07f3\u0816-\u0819\u081b-\u0823\u0825-\u0827\u0829-\u082d" +
    "\u0859-\u085b\u08e4-\u08fe\u0900-\u0903\u093a-\u093c\u093e-\u094f\u0951-\u0957" +
    "\u0962-\u0963\u0981-\u0983\u09bc\u09be-\u09c4\u09c7-\u09c8\u09cb-\u09cd\u09d7\u09e2-\u09e3" +
    "\u0a01-\u0a03\u0a3c\u0a3e-\u0a42\u0a47-\u0a48\u0a4b-\u0a4d\u0a51\u0a70-\u0a71\u0a75" +
    "\u0a81-\u0a83\u0abc\u0abe-\u0ac5\u0ac7-\u0ac9\u0acb-\u0acd\u0ae2-\u0ae3\u0b01-\u0b03\u0b3c" +
    "\u0b3e-\u0b44\u0b47-\u0b48\u0b4b-\u0b4d\u0b56-\u0b57\u0b62-\u0b63\u0b82\u0bbe-\u0bc2" +
    "\u0bc6-\u0bc8\u0bca-\u0bcd\u0bd7\u0c01-\u0c03\u0c3e-\u0c44\u0c46-\u0c48\u0c4a-\u0c4d" +
    "\u0c55-\u0c56\u0c62-\u0c63\u0c82-\u0c83\u0cbc\u0cbe-\u0cc4\u0cc6-\u0cc8\u0cca-\u0ccd" +
    "\u0cd5-\u0cd6\u0ce2-\u0ce3\u0d02-\u0d03\u0d3e-\u0d44\u0d46-\u0d48\u0d4a-\u0d4d\u0d57" +
    "\u0d62-\u0d63\u0d82-\u0d83\u0dca\u0dcf-\u0dd4\u0dd6\u0dd8-\u0ddf\u0df2-\u0df3\u0e31" +
    "\u0e34-\u0e3a\u0e47-\u0e4e\u0eb1\u0eb4-\u0eb9\u0ebb-\u0ebc\u0ec8-\u0ecd\u0f18-\u0f19\u0f35" +
    "\u0f37\u0f39\u0f3e-\u0f3f\u0f71-\u0f84\u0f86-\u0f87\u0f8d-\u0f97\u0f99-\u0fbc\u0fc6" +
    "\u102b-\u103e\u1056-\u1059\u105e-\u1060\u1062-\u1064\u1067-\u106d\u1071-\u1074" +
    "\u1082-\u108d\u108f\u109a-\u109d\u135d-\u135f\u1712-\u1714\u1732-\u1734\u1752-\u1753" +
    "\u1772-\u1773\u17b4-\u17d3\u17dd\u180b-\u180d\u18a9\u1920-\u192b\u1930-\u193b\u19b0-\u19c0" +
    "\u19c8-\u19c9\u1a17-\u1a1b\u1a55-\u1a5e\u1a60-\u1a7c\u1a7f\u1b00-\u1b04\u1b34-\u1b44" +
    "\u1b6b-\u1b73\u1b80-\u1b82\u1ba1-\u1bad\u1be6-\u1bf3\u1c24-\u1c37\u1cd0-\u1cd2" +
    "\u1cd4-\u1ce8\u1ced\u1cf2-\u1cf4\u1dc0-\u1de6\u1dfc-\u1dff\u20d0-\u20f0\u2cef-\u2cf1\u2d7f" +
    "\u2de0-\u2dff\u302a-\u302f\u3099-\u309a\ua66f-\ua672\ua674-\ua67d\ua69f\ua6f0-\ua6f1\ua802" +
    "\ua806\ua80b\ua823-\ua827\ua880-\ua881\ua8b4-\ua8c4\ua8e0-\ua8f1\ua926-\ua92d\ua947-\ua953" +
    "\ua980-\ua983\ua9b3-\ua9c0\uaa29-\uaa36\uaa43\uaa4c-\uaa4d\uaa7b\uaab0\uaab2-\uaab4" +
    "\uaab7-\uaab8\uaabe-\uaabf\uaac1\uaaeb-\uaaef\uaaf5-\uaaf6\uabe3-\uabea\uabec-\uabed\ufb1e" +
    "\ufe00-\ufe0f\ufe20-\ufe26\u{101fd}\u{10a01}-\u{10a03}\u{10a05}-\u{10a06}" +
    "\u{10a0c}-\u{10a0f}\u{10a38}-\u{10a3a}\u{10a3f}\u{11000}-\u{11002}\u{11038}-\u{11046}" +
    "\u{11080}-\u{11082}\u{110b0}-\u{110ba}\u{11100}-\u{11102}\u{11127}-\u{11134}" +
    "\u{11180}-\u{11182}\u{111b3}-\u{111c0}\u{116ab}-\u{116b7}\u{16f51}-\u{16f7e}" +
    "\u{16f8f}-\u{16f92}\u{1d165}-\u{1d169}\u{1d16d}-\u{1d172}\u{1d17b}-\u{1d182}" +
    "\u{1d185}-\u{1d18b}\u{1d1aa}-\u{1d1ad}\u{1d242}-\u{1d244}\u{e0100}-\u{e01ef}]",
  "u",
);

function unicode61TokenizerKey(term: string): string {
  let key = "";
  for (const character of term) {
    if (UNICODE61_DIACRITIC.test(character)) {
      continue;
    }
    if (UNICODE61_MARK.test(character)) {
      key += " ";
      continue;
    }
    const decomposed = Array.from(character.normalize("NFD"));
    const base = decomposed[0];
    const foldedBase = base ? simpleCaseFold(base) : undefined;
    if (
      decomposed.length === 2 &&
      UNICODE61_DIACRITIC.test(decomposed[1] ?? "") &&
      foldedBase &&
      /^[a-z]$/u.test(foldedBase)
    ) {
      key += foldedBase;
      continue;
    }
    key += simpleCaseFold(character);
  }
  return key.replace(/ +/g, " ").trim();
}

function canonicalTermForms(term: string, tokenizer?: FtsCanonicalTokenizer): string[] {
  if (!tokenizer) {
    return [term];
  }
  const seen = new Set<string>();
  return [term, term.normalize("NFC"), term.normalize("NFD")].filter((form) => {
    const key =
      tokenizer === "unicode61"
        ? unicode61TokenizerKey(form)
        : Array.from(form, simpleCaseFold).join("");
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
  matchAny = false,
): string | null {
  if (terms.length === 0) {
    return null;
  }
  const quoted = uniqueStrings(terms).map((term) => {
    const forms = canonicalTermForms(term, canonicalTokenizer);
    const alternatives = forms.map((form) => `"${form.replaceAll('"', "")}"`);
    // Alternatives belong to each word: one document can mix NFC and NFD words.
    return alternatives.length === 1 ? alternatives[0] : `(${alternatives.join(" OR ")})`;
  });
  return quoted.join(matchAny ? " OR " : " AND ");
}

export function planKeywordSearch(params: {
  query: string;
  ftsTokenizer?: "unicode61" | "trigram";
  includeLeadingMarks?: boolean;
  canonicalVariants?: boolean;
  matchAny?: boolean;
}): { matchQuery: string | null; substringTerms: string[]; tokens: string[] } {
  const canonicalTokenizer = params.canonicalVariants
    ? (params.ftsTokenizer ?? "unicode61")
    : undefined;
  const tokens = tokenizeFtsQuery(
    params.query,
    params.ftsTokenizer === "trigram" && params.includeLeadingMarks,
  );
  if (params.matchAny) {
    // Retain the existing six-term language expansion without double-counting
    // terms already present in a different case or canonical spelling.
    const key = (term: string) => Array.from(term.normalize("NFC"), simpleCaseFold).join("");
    const seen = new Set(tokens.map(key));
    const expanded = extractKeywords(params.query.normalize("NFC"), params).slice(0, 6);
    for (const token of tokenizeFtsQuery(expanded.join(" "))) {
      if (!seen.has(key(token))) {
        seen.add(key(token));
        tokens.push(token);
      }
    }
  }
  if (params.ftsTokenizer !== "trigram") {
    const matchQuery = buildMatchQueryFromTerms(tokens, canonicalTokenizer, params.matchAny);
    return { matchQuery, substringTerms: [], tokens };
  }
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
    matchQuery: buildMatchQueryFromTerms(matchTerms, canonicalTokenizer, params.matchAny),
    substringTerms,
    tokens,
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
