import type { GateEntry } from "./recall-gate.js";

/** Excerpt budget for keyword candidates. */
export type KeywordExcerptPolicy = {
  /** Most passages quoted per page. */
  excerpts: number;
  /** Characters per passage. */
  excerptChars: number;
  /** Characters per page across its passages. */
  pageChars: number;
};

/** One page the keyword shortlist may offer: its gate entry plus the text it is matched on. */
export type KeywordPage = { entry: GateEntry; body: string };

const STOP = new Set(
  "a an and are as at be been can did do does for from had has have how i in is it me my of on or our should that the their them there these they this to us was we were what when where which who why with would you your please tell about now".split(
    " ",
  ),
);
const K1 = 1.2;
const B = 0.75;
const TITLE_BOOST = 4;

/** Normalized word token with simple plural folding, or undefined for stopwords and one-letter words. */
function keywordToken(word: string): string | undefined {
  const token = word.normalize("NFKC").toLowerCase();
  if (/^.?$/su.test(token) || STOP.has(token)) {
    return undefined;
  }
  return token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token;
}

/** Unicode letter/number runs; apostrophes split words, so possessive "'s" drops as a one-letter word. */
const WORD = /[\p{L}\p{M}\p{N}]+/gu;

/** Lowercased, NFKC-normalized word tokens in any script, without stopwords. */
function keywordTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const [word] of text.normalize("NFKC").matchAll(WORD)) {
    const token = keywordToken(word);
    if (token !== undefined) {
      tokens.push(token);
    }
  }
  return tokens;
}

/**
 * The `size`-character window of `text` that covers the most query weight,
 * so a long passage is never clipped away from the words that matched it.
 */
function matchWindow(
  text: string,
  query: ReadonlySet<string>,
  idf: (token: string) => number,
  size: number,
): string {
  if (text.length <= size) {
    return text;
  }
  const hits: { at: number; end: number; token: string }[] = [];
  for (const match of text.matchAll(WORD)) {
    const token = keywordToken(match[0]);
    if (token !== undefined && query.has(token)) {
      hits.push({ at: match.index, end: match.index + match[0].length, token });
    }
  }
  let best = { start: 0, score: -1 };
  for (const hit of hits) {
    const start = Math.max(0, Math.min(hit.at - Math.floor(size / 8), text.length - size));
    const seen = new Set<string>();
    for (const other of hits) {
      if (other.at >= start && other.end <= start + size) {
        seen.add(other.token);
      }
    }
    const score = [...seen].reduce((sum, token) => sum + idf(token), 0);
    if (score > best.score) {
      best = { start, score };
    }
  }
  return text.slice(best.start, best.start + size);
}

/** Blank-line separated passages; a page without breaks is one passage. */
function passages(body: string): string[] {
  const parts = body
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : [body.trim()];
}

/**
 * BM25 over page titles and bodies with a title-match boost; returns the top
 * `limit` pages that share at least one query term, each with its best
 * passages as the excerpt. Ties keep page id order, so results are stable.
 */
export function keywordCandidates(
  message: string,
  pages: readonly KeywordPage[],
  limit: number,
  policy: KeywordExcerptPolicy,
): GateEntry[] {
  const query = [...new Set(keywordTokens(message))];
  if (query.length === 0 || pages.length === 0 || limit < 1) {
    return [];
  }
  const df = new Map<string, number>();
  let total = 0;
  const docs = pages.map((page) => {
    const parts = passages(page.body);
    const tokens = keywordTokens(`${page.entry.label} ${parts.join(" ")}`);
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    for (const token of tf.keys()) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
    total += tokens.length;
    return {
      page,
      parts,
      tf,
      length: tokens.length,
      title: new Set(keywordTokens(page.entry.label)),
    };
  });
  const average = total / docs.length || 1;
  const idf = (token: string) => {
    const n = df.get(token) ?? 0;
    return Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
  };
  const scored = docs
    .map((doc) => {
      let score = 0;
      for (const token of query) {
        const f = doc.tf.get(token) ?? 0;
        if (f) {
          score += (idf(token) * f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / average));
        }
        if (doc.title.has(token)) {
          score += idf(token) * TITLE_BOOST;
        }
      }
      return { doc, score };
    })
    .filter(({ score }) => score > 0)
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        (a.doc.page.entry.id < b.doc.page.entry.id
          ? -1
          : a.doc.page.entry.id > b.doc.page.entry.id
            ? 1
            : 0),
    )
    .slice(0, limit);
  return scored.map(({ doc }) => {
    const { id, line, label, handle } = doc.page.entry;
    const text = excerpt(doc.parts, query, idf, policy);
    return handle === undefined ? { id, line, label, text } : { id, line, label, handle, text };
  });
}

/** The page's best passages for the query, in rank order, within the page budget. */
function excerpt(
  parts: readonly string[],
  query: readonly string[],
  idf: (token: string) => number,
  policy: KeywordExcerptPolicy,
): string {
  const wanted = new Set(query);
  const scored = parts.map((text, index) => {
    const tokens = new Set(keywordTokens(text));
    const score = query.reduce((sum, token) => sum + (tokens.has(token) ? idf(token) : 0), 0);
    return { text, index, score };
  });
  // Passages that share a query word, best first; a title-only match quotes the opening passage.
  const matched = scored.filter(({ score }) => score > 0);
  const ranked = (matched.length ? matched : scored.slice(0, 1))
    .toSorted((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, policy.excerpts);
  const chosen: string[] = [];
  let used = 0;
  for (const { text } of ranked) {
    // The page budget covers the joining newlines; each window fits what is left.
    const room = Math.min(policy.excerptChars, policy.pageChars - used - (chosen.length ? 1 : 0));
    if (room < 1) {
      break;
    }
    const clipped = matchWindow(text, wanted, idf, room);
    used += clipped.length + (chosen.length ? 1 : 0);
    chosen.push(clipped);
  }
  return chosen.join("\n");
}
