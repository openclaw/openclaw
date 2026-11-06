import {
  estimateStringCharsWithMinimumRawWeight as estimateToolResultTextChars,
  type StringCharBudgetOptions,
} from "@openclaw/normalization-core/cjk-chars";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { memoizeFrozenPlainDataProjection } from "../../shared/immutable-data.js";
import type { AgentMessage } from "../runtime/index.js";

export { estimateToolResultTextChars };

const getToolResultContentBudget = memoizeFrozenPlainDataProjection((content: unknown[]) => {
  let chars = 0;
  for (const block of content) {
    if (isToolResultTextBlock(block)) {
      chars += prepareToolResultTextChars(block, block.text, 1);
    }
  }
  return chars;
});

export function getToolResultTextBudget(msg: AgentMessage): number {
  if (!msg || msg.role !== "toolResult") {
    return 0;
  }
  const content = msg.content;
  return Array.isArray(content) ? getToolResultContentBudget(content) : 0;
}

export function getToolResultHistoryTextBudget(messages: AgentMessage[]) {
  let totalChars = 0;
  let largestChars = 0;
  const textLengths = messages.map((message) => {
    const chars = getToolResultTextBudget(message);
    totalChars += chars;
    largestChars = Math.max(largestChars, chars);
    return chars;
  });
  return { textLengths, totalChars, largestChars };
}

type ToolResultTextEstimate = { text: string; minimumRawWeight: number; chars: number };
// Initial model history is writable. Text is the revision; weak block keys own its lifetime.
// Keep history's default weight separate from the guard's floor without retaining every floor.
const defaultTextEstimates = new WeakMap<object, ToolResultTextEstimate>();
const weightedTextEstimates = new WeakMap<object, ToolResultTextEstimate>();

export function prepareToolResultTextChars(
  block: object,
  text: string,
  minimumRawWeight: number,
): number {
  const estimates = minimumRawWeight === 1 ? defaultTextEstimates : weightedTextEstimates;
  const cached = estimates.get(block);
  if (cached?.text === text && cached.minimumRawWeight === minimumRawWeight) {
    return cached.chars;
  }
  const chars = estimateToolResultTextChars(text, { minimumRawWeight });
  estimates.set(block, { text, minimumRawWeight, chars });
  return chars;
}

export function isToolResultTextBlock(
  block: unknown,
): block is { type: "text" | "toolResult"; text: string; content?: unknown } {
  if (!block || typeof block !== "object") {
    return false;
  }
  const type: unknown = Reflect.get(block, "type");
  return (
    (type === "text" || type === "toolResult") && typeof Reflect.get(block, "text") === "string"
  );
}

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
  const additive = [1, 2].includes(Math.max(1, options.minimumRawWeight ?? 1));
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
