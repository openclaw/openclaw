// Minimal pure-TypeScript TF-IDF + cosine similarity.
// No external dependencies.

/** Lowercase + split on anything that's not a letter/number. Empty tokens dropped. */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const baseTokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((tok) => tok.length > 0);
  const tokens = [...baseTokens];
  for (const token of baseTokens) {
    const chars = [...token];
    if (chars.length < 2) continue;
    const hasCjk = chars.some((char) =>
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char),
    );
    if (!hasCjk) continue;
    for (let index = 0; index < chars.length - 1; index++) {
      tokens.push(chars.slice(index, index + 2).join(""));
    }
  }
  return tokens;
}

export type TfMap = Map<string, number>;

/** Raw term-frequency map for a single document. */
export function termFrequency(tokens: string[]): TfMap {
  const tf: TfMap = new Map();
  for (const tok of tokens) {
    tf.set(tok, (tf.get(tok) ?? 0) + 1);
  }
  return tf;
}

/** Document frequency across a corpus of token arrays. */
export function documentFrequency(corpus: string[][]): Map<string, number> {
  const df = new Map<string, number>();
  for (const tokens of corpus) {
    const seen = new Set(tokens);
    for (const tok of seen) {
      df.set(tok, (df.get(tok) ?? 0) + 1);
    }
  }
  return df;
}

/**
 * Compute a TF-IDF vector for `tokens` given document frequencies and corpus size.
 * Uses log-normalized IDF: `ln(1 + N / (1 + df))`.
 */
export function tfidfVector(tokens: string[], df: Map<string, number>, corpusSize: number): TfMap {
  const tf = termFrequency(tokens);
  const vec: TfMap = new Map();
  for (const [term, freq] of tf) {
    const docFreq = df.get(term) ?? 0;
    const idf = Math.log(1 + corpusSize / (1 + docFreq));
    const weight = freq * idf;
    if (weight > 0) vec.set(term, weight);
  }
  return vec;
}

export function dot(a: TfMap, b: TfMap): number {
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [term, w] of small) {
    const other = large.get(term);
    if (other !== undefined) sum += w * other;
  }
  return sum;
}

export function magnitude(v: TfMap): number {
  let sq = 0;
  for (const w of v.values()) sq += w * w;
  return Math.sqrt(sq);
}

export function cosine(a: TfMap, b: TfMap): number {
  const ma = magnitude(a);
  const mb = magnitude(b);
  if (ma === 0 || mb === 0) return 0;
  return dot(a, b) / (ma * mb);
}
