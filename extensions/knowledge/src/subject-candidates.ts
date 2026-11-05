// Adapted from gbrain src/core/context/entity-salience.ts (strong pass only);
// see THIRD_PARTY_NOTICES.md.

/** One capitalized name or @handle a claim's text may refer to. */
export type NameCandidate = {
  query: string;
  /** A single token seen capitalized only at a sentence start, so the capital is no name evidence. */
  sentenceStart?: true;
};

/** Most candidates one text yields; bounds lookup work. */
const MAX_CANDIDATES = 12;

/** Function words that are never a name, even capitalized. Compared lowercase. */
const STOPWORDS = new Set([
  "i",
  "i'm",
  "i've",
  "i'll",
  "you",
  "you're",
  "he",
  "she",
  "it",
  "it's",
  "we",
  "we're",
  "they",
  "they're",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "his",
  "their",
  "our",
  "mine",
  "yours",
  "hers",
  "theirs",
  "ours",
  "this",
  "that",
  "these",
  "those",
  "who",
  "whom",
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "so",
  "if",
  "as",
  "at",
  "by",
  "for",
  "in",
  "of",
  "on",
  "to",
  "up",
  "with",
  "from",
  "into",
  "over",
  "than",
  "then",
  "also",
  "just",
  "what",
  "when",
  "where",
  "why",
  "how",
  "which",
  "whose",
  "can",
  "could",
  "should",
  "would",
  "will",
  "shall",
  "may",
  "might",
  "must",
  "do",
  "does",
  "did",
  "is",
  "are",
  "am",
  "was",
  "were",
  "be",
  "been",
  "being",
  "has",
  "have",
  "had",
  "hi",
  "hey",
  "hello",
  "thanks",
  "thank",
  "please",
  "yes",
  "no",
  "ok",
  "okay",
  "sure",
  "maybe",
  "well",
  "oh",
  "let",
  "let's",
  "lets",
]);

/** Frequent non-name words that get capitalized at a sentence start. Compared lowercase. */
const COMMON_WORDS = new Set([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "today",
  "tomorrow",
  "yesterday",
  "now",
  "soon",
  "later",
  "tonight",
  "morning",
  "afternoon",
  "evening",
  "week",
  "month",
  "year",
  "meeting",
  "call",
  "note",
  "task",
  "here",
  "there",
  "every",
  "some",
  "any",
  "all",
  "one",
  "two",
  "three",
  "first",
  "last",
  "next",
  "new",
  "old",
  "good",
  "bad",
  "great",
  "nice",
  "thing",
  "something",
  "anything",
]);

/** True for frequent non-name words (weekdays, months, time words) that get capitalized, and their plurals ("Tuesdays"). */
export function isCommonCapitalizedWord(token: string): boolean {
  const lc = token.toLowerCase();
  return (
    COMMON_WORDS.has(lc) || (lc.length > 3 && lc.endsWith("s") && COMMON_WORDS.has(lc.slice(0, -1)))
  );
}

const HANDLE_RE = /@([A-Za-z0-9_]{2,})/g;
// An uppercase-initial word, with internal dots only before a letter ("U.S."
// keeps its dot; a sentence-ending "Apple." does not glue into the next word).
const CAP_TOKEN = "\\p{Lu}[\\p{L}0-9'’\\-]*(?:\\.\\p{L}[\\p{L}0-9'’\\-]*)*";
const CAP_RUN_RE = new RegExp(`${CAP_TOKEN}(?:\\s+${CAP_TOKEN}){0,3}`, "gu");

const stripPossessive = (s: string) => s.replace(/['’]s$/iu, "").replace(/['’]$/u, "");
const key = (s: string) => s.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

// True when the match at idx opens the text or follows sentence punctuation.
function atSentenceStart(text: string, idx: number): boolean {
  let i = idx - 1;
  while (i >= 0 && /\s/u.test(text[i]!)) {
    i--;
  }
  return i < 0 || /[.!?:;\n\r•\-(["“]/u.test(text[i]!);
}

/**
 * Capitalized name runs (up to four tokens) and @handles in one text, deduped
 * case-insensitively and filtered for precision: stopwords, numbers and single
 * characters never qualify, and a common word qualifies only when it is also
 * seen capitalized mid-sentence. A leading stopword is shed into an extra
 * candidate ("Did Atlas" also yields "Atlas").
 */
export function nameCandidates(text: string): NameCandidate[] {
  const seen = new Map<string, { query: string; multiToken: boolean; midSentence: boolean }>();
  const consider = (raw: string, midSentence: boolean) => {
    const query = stripPossessive(raw.trim()),
      norm = key(query);
    if (!norm) {
      return;
    }
    const existing = seen.get(norm);
    if (existing) {
      existing.midSentence ||= midSentence;
      return;
    }
    seen.set(norm, { query, multiToken: /\s/u.test(query), midSentence });
  };
  // Handles are deliberate references, so they never count as sentence openers.
  for (const m of text.matchAll(HANDLE_RE)) {
    consider(m[1]!, true);
  }
  for (const m of text.matchAll(CAP_RUN_RE)) {
    const surface = m[0];
    consider(surface, !atSentenceStart(text, m.index ?? 0));
    // "Did Atlas" glues an auxiliary onto the name; also consider the name alone.
    const tokens = surface.split(/\s+/u);
    let first = 0;
    while (first < tokens.length && STOPWORDS.has(stripPossessive(tokens[first]!).toLowerCase())) {
      first++;
    }
    if (first > 0 && first < tokens.length) {
      consider(tokens.slice(first).join(" "), true);
    }
  }
  const out: NameCandidate[] = [];
  for (const c of seen.values()) {
    const lc = c.query.toLowerCase();
    // Multi-token runs are high-signal; single tokens get the strict filters.
    if (
      !c.multiToken &&
      (c.query.length < 2 ||
        /^[0-9][0-9.,]*$/u.test(c.query) ||
        STOPWORDS.has(lc) ||
        (isCommonCapitalizedWord(lc) && !c.midSentence))
    ) {
      continue;
    }
    out.push({
      query: c.query,
      ...(!c.multiToken && !c.midSentence ? { sentenceStart: true as const } : {}),
    });
    if (out.length >= MAX_CANDIDATES) {
      break;
    }
  }
  return out;
}
