import {
  estimateStringCharsWithMinimumRawWeight as estimateToolResultTextChars,
  type StringCharBudgetOptions,
} from "@openclaw/normalization-core/cjk-chars";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

export { estimateToolResultTextChars };

function sliceToolResultTextBudget(
  text: string,
  maxChars: number,
  options: StringCharBudgetOptions,
  fromEnd: boolean,
): string {
  const budget = Math.max(0, Math.floor(maxChars));
  if (text.length <= budget && estimateToolResultTextChars(text, options) <= budget) {
    return text;
  }
  let best = "";
  let low = 0;
  // Every UTF-16 unit costs at least one budget unit, so longer candidates cannot fit.
  let high = Math.min(text.length, budget);
  const minimumRawWeight = Math.max(1, options.minimumRawWeight ?? 1);
  const additive = minimumRawWeight === 1 || minimumRawWeight === 2;
  let measuredLength = 0;
  let measuredChars = 0;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = fromEnd
      ? sliceUtf16Safe(text, text.length - midpoint)
      : sliceUtf16Safe(text, 0, midpoint);
    if (additive) {
      // Safe cuts delimit complete code points, whose integer weights add.
      // Count only the changed interval; other floors need full measurement
      // because rounding belongs to each ASCII run.
      const start = Math.min(measuredLength, candidate.length);
      const end = Math.max(measuredLength, candidate.length);
      const delta = fromEnd
        ? text.slice(text.length - end, text.length - start)
        : text.slice(start, end);
      const deltaChars = estimateToolResultTextChars(delta, options);
      measuredChars += candidate.length >= measuredLength ? deltaChars : -deltaChars;
      measuredLength = candidate.length;
    } else {
      measuredChars = estimateToolResultTextChars(candidate, options);
    }
    if (measuredChars <= budget) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
}

export function sliceToolResultTextToBudget(
  text: string,
  maxChars: number,
  options: StringCharBudgetOptions = {},
): string {
  return sliceToolResultTextBudget(text, maxChars, options, false);
}

export function sliceToolResultTextTailToBudget(
  text: string,
  maxChars: number,
  options: StringCharBudgetOptions = {},
): string {
  return sliceToolResultTextBudget(text, maxChars, options, true);
}
