import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const CJK_RE = /[\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\u1100-\u11ff]/;
const CJK_RUN_RE = new RegExp(`${CJK_RE.source}+`, "g");

// Only adjacent CJK characters form bigrams: "我喜欢hello你好" must not yield "欢你".
function tokenize(text: string): Set<string> {
  const lower = normalizeLowercaseStringOrEmpty(text).normalize("NFC");
  // Keep CJK in its existing bigram/unigram lane; word marks stay attached to a base.
  const words = lower.replace(CJK_RUN_RE, " ").match(/[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*/gu) ?? [];
  const tokens = new Set(words);
  const cjkRuns = lower.match(CJK_RUN_RE) ?? [];
  for (const run of cjkRuns) {
    for (let index = 1; index < run.length; index += 1) {
      tokens.add(run.slice(index - 1, index + 1));
    }
  }

  // Preserve insertion order: word tokens, then bigrams, then unigrams.
  for (const run of cjkRuns) {
    for (const char of run) {
      tokens.add(char);
    }
  }
  return tokens;
}

function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) {
    return 1;
  }
  let intersectionSize = 0;
  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = setA.size <= setB.size ? setB : setA;

  for (const token of smaller) {
    if (larger.has(token)) {
      intersectionSize++;
    }
  }

  const unionSize = setA.size + setB.size - intersectionSize;
  return intersectionSize / unionSize;
}

export type PreparedSimilarityText = {
  tokens: Set<string>;
  // Set only for token-less text, which compares by literal equality.
  emptyTokenText: string | undefined;
};

// Tokenize once so repeated comparisons against the same text skip re-tokenizing.
export function prepareSimilarityText(text: string): PreparedSimilarityText {
  const tokens = tokenize(text);
  return {
    tokens,
    emptyTokenText: tokens.size === 0 ? normalizeLowercaseStringOrEmpty(text) : undefined,
  };
}

// Distinct text outside the tokenizer's alphabet must not collapse as two empty sets.
export function preparedTextSimilarity(
  a: PreparedSimilarityText,
  b: PreparedSimilarityText,
): number {
  if (a.tokens.size === 0 && b.tokens.size === 0) {
    return a.emptyTokenText === b.emptyTokenText ? 1 : 0;
  }
  return jaccardSimilarity(a.tokens, b.tokens);
}
