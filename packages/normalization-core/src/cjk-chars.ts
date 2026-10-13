/**
 * Shared CJK-aware character counting for approximate token estimates.
 *
 * This is a provider-independent budget heuristic, not an exact tokenizer.
 * Weighting common CJK, rare BMP characters, width-compatibility forms, and
 * supplementary ideographs separately keeps current tokenizers within a
 * conservative budget range while preserving the existing Latin behavior.
 */

export const CHARS_PER_TOKEN_ESTIMATE = 4;

export type StringCharBudgetOptions = { minimumRawWeight?: number };
const DEFAULT_BUDGET_OPTIONS: StringCharBudgetOptions = {};
const ASCII_RUN_OR_NON_ASCII_CODE_POINT_RE = /[\p{ASCII}]+|[^\p{ASCII}]/gu;
const NON_ASCII_RE = /[\u0080-\u{10FFFF}]/u;

const WEIGHTED_CJK_RANGES = [
  [
    [0x00b7, 0x00b7],
    [0x3000, 0x319f],
    [0x4e00, 0x9fa5],
    [0xac00, 0xd7af],
    [0xff01, 0xff60],
  ],
  [
    [0x1100, 0x11ff],
    [0x2e80, 0x2fff],
    [0x31a0, 0x4dff],
    [0x9fa6, 0x9fff],
    [0xa000, 0xa4ff],
    [0xa700, 0xa707],
    [0xa960, 0xa97f],
    [0xd7b0, 0xd7ff],
    [0xf900, 0xfaff],
  ],
  [
    [0x02c7, 0x02c7],
    [0x02c9, 0x02cb],
    [0x02d9, 0x02d9],
    [0x02ea, 0x02eb],
    [0x0305, 0x0305],
    [0x0323, 0x0323],
    [0xfe10, 0xfe4f],
    [0xff61, 0xffdc],
    [0xffe0, 0xffe6],
  ],
  [[0x1d360, 0x1d371]],
  [
    [0x16fe0, 0x16fff],
    [0x1aff0, 0x1afff],
    [0x1b000, 0x1b16f],
    [0x1f200, 0x1f2ff],
    [0x20000, 0x2fa1f],
    [0x30000, 0x3347f],
  ],
] as const;

const WEIGHTED_CJK_RE = new RegExp(
  `[${WEIGHTED_CJK_RANGES.flatMap((ranges) =>
    ranges.map(([start, end]) => `\\u{${start.toString(16)}}-\\u{${end.toString(16)}}`),
  ).join("")}]`,
  "u",
);

// A fixed 205 KiB lookup avoids rescanning multilingual text for each weight.
const CJK_CATEGORY: Readonly<ArrayLike<number>> = (() => {
  const maxCodePoint = Math.max(
    ...WEIGHTED_CJK_RANGES.flatMap((ranges) => ranges.map(([, end]) => end)),
  );
  const categories = new Uint8Array(maxCodePoint + 1);
  for (const [bucket, ranges] of WEIGHTED_CJK_RANGES.entries()) {
    for (const [start, end] of ranges) {
      categories.fill(bucket + 1, start, end + 1);
    }
  }
  return categories;
})();

export function estimateStringChars(text: string): number {
  return estimateStringCharsWithMinimumRawWeight(text);
}

/** Apply a raw-text safety floor without multiplying CJK adjustments twice. */
export function estimateStringCharsWithMinimumRawWeight(
  text: string,
  options: StringCharBudgetOptions = DEFAULT_BUDGET_OPTIONS,
): number {
  const minimumRawWeight = Math.max(1, options.minimumRawWeight ?? 1);
  if (minimumRawWeight !== 1 && minimumRawWeight !== 2) {
    let chars = 0;
    // Other floors retain per-ASCII-run rounding and left-to-right numeric behavior.
    for (const match of text.matchAll(ASCII_RUN_OR_NON_ASCII_CODE_POINT_RE)) {
      const segment = match[0];
      const minimumChars = Math.ceil(segment.length * minimumRawWeight);
      chars +=
        segment.charCodeAt(0) <= 0x7f
          ? minimumChars
          : Math.max(estimateStringChars(segment), minimumChars);
    }
    return chars;
  }
  if (!NON_ASCII_RE.test(text)) {
    return text.length * minimumRawWeight;
  }
  const firstWeighted = text.search(WEIGHTED_CJK_RE);
  if (firstWeighted < 0) {
    return text.length * minimumRawWeight;
  }
  let common = 0;
  let rareBmp = 0;
  let twoToken = 0;
  let threeTokenSupplementary = 0;
  let supplementary = 0;
  for (let index = firstWeighted; index < text.length; index += 1) {
    let codePoint = text.charCodeAt(index);
    if (codePoint < 0x80) {
      continue;
    }
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + (codePoint - 0xd800) * 0x400 + low - 0xdc00;
        index += 1;
      }
    }
    switch (CJK_CATEGORY[codePoint]) {
      case 1:
        common += 1;
        break;
      case 2:
        rareBmp += 1;
        break;
      case 3:
        twoToken += 1;
        break;
      case 4:
        threeTokenSupplementary += 1;
        break;
      case 5:
        supplementary += 1;
        break;
      default:
        break;
    }
  }
  const commonEstimate =
    text.length * minimumRawWeight + common * (CHARS_PER_TOKEN_ESTIMATE - minimumRawWeight);
  return (
    commonEstimate +
    rareBmp * (CHARS_PER_TOKEN_ESTIMATE * 3 - minimumRawWeight) +
    twoToken * (CHARS_PER_TOKEN_ESTIMATE * 2 - minimumRawWeight) +
    threeTokenSupplementary * (CHARS_PER_TOKEN_ESTIMATE * 3 - 2 * minimumRawWeight) +
    supplementary * (CHARS_PER_TOKEN_ESTIMATE * 4 - 2 * minimumRawWeight)
  );
}

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN_ESTIMATE);
}
