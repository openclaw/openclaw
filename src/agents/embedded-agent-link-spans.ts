import type { FenceSpan } from "../../packages/markdown-core/src/fences.js";
import { isSafeFenceBreak } from "../../packages/markdown-core/src/fences.js";
import { findMarkdownLinkSourceSpans } from "../../packages/markdown-core/src/link-spans.js";

export type UnbreakableSpan = {
  start: number;
  end: number;
  complete: boolean;
};

const URL_OPENERS = ["http://", "https://", "<http://", "<https://"] as const;

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  let cursor = index;
  while (cursor > 0 && text[--cursor] === "\\") {
    slashes++;
  }
  return slashes % 2 === 1;
}

function endsBlankLine(text: string, index: number): boolean {
  if (text[index] !== "\n") {
    return false;
  }
  let cursor = index - 1;
  if (text[cursor] === "\r") {
    cursor--;
  }
  while (text[cursor] === " " || text[cursor] === "\t") {
    cursor--;
  }
  return text[cursor] === "\n";
}

function findMarkdownLabelStart(
  text: string,
  labelEnd: number,
  isInsideCode: (index: number) => boolean,
): number {
  let depth = 0;
  for (let index = labelEnd - 1; index >= 0; index--) {
    if (isEscaped(text, index)) {
      continue;
    }
    if (endsBlankLine(text, index)) {
      return -1;
    }
    if (isInsideCode(index)) {
      continue;
    }
    if (text[index] === "]") {
      depth++;
    } else if (text[index] === "[") {
      if (depth === 0) {
        return index;
      }
      depth--;
    }
  }
  return -1;
}

function findOpenMarkdownLabelStart(
  text: string,
  isInsideCode: (index: number) => boolean,
): number {
  const openers: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (isEscaped(text, index)) {
      continue;
    }
    if (endsBlankLine(text, index)) {
      openers.length = 0;
    } else if (isInsideCode(index)) {
      continue;
    } else if (text[index] === "[") {
      openers.push(index);
    } else if (text[index] === "]") {
      openers.pop();
    }
  }
  return openers[0] ?? -1;
}

function buildInlineCodeIndex(text: string, fenceSpans: FenceSpan[]) {
  const spans: Array<{ start: number; end: number }> = [];
  let openTicks = 0;
  let openStart = -1;
  let fenceIndex = 0;

  for (let index = 0; index < text.length;) {
    const fence = fenceSpans[fenceIndex];
    if (fence && index >= fence.start) {
      index = fence.end;
      fenceIndex++;
      continue;
    }
    if (text[index] !== "`" || isEscaped(text, index)) {
      index++;
      continue;
    }
    const runStart = index;
    while (text[index] === "`") {
      index++;
    }
    const ticks = index - runStart;
    if (openTicks === 0) {
      openTicks = ticks;
      openStart = runStart;
    } else if (ticks === openTicks) {
      spans.push({ start: openStart, end: index });
      openTicks = 0;
      openStart = -1;
    }
  }
  return (index: number) => {
    if (!isSafeFenceBreak(fenceSpans, index)) {
      return true;
    }
    let low = 0;
    let high = spans.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((spans[middle]?.end ?? 0) <= index) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const span = spans[low];
    return span !== undefined && index >= span.start && index < span.end;
  };
}

function hasUnfinishedMarkdownDestination(text: string, start: number): boolean {
  let index = start;
  let depth = 0;
  let hasDestination = false;

  if (text[index] === "<") {
    index++;
    while (index < text.length && text[index] !== ">") {
      if (text[index] === "\n" || text[index] === "\r") {
        return false;
      }
      index += text[index] === "\\" ? 2 : 1;
    }
    if (index >= text.length) {
      return true;
    }
    index++;
    hasDestination = true;
  } else {
    while (index < text.length) {
      const char = text[index];
      if (char === "\\") {
        hasDestination = true;
        index += 2;
      } else if (char === "(") {
        depth++;
        hasDestination = true;
        index++;
      } else if (char === ")") {
        if (depth === 0) {
          return false;
        }
        depth--;
        hasDestination = true;
        index++;
      } else if (/\s/u.test(char ?? "")) {
        break;
      } else {
        hasDestination = true;
        index++;
      }
    }
  }

  if (!hasDestination) {
    if (index >= text.length) {
      return true;
    }
    return false;
  }
  while (/[\t\n\r ]/u.test(text[index] ?? "")) {
    if (endsBlankLine(text, index)) {
      return false;
    }
    index++;
  }
  if (index >= text.length) {
    return true;
  }

  const titleDelimiter = text[index];
  const titleCloser = titleDelimiter === "(" ? ")" : titleDelimiter;
  if (titleDelimiter !== '"' && titleDelimiter !== "'" && titleDelimiter !== "(") {
    return false;
  }
  index++;
  while (index < text.length && text[index] !== titleCloser) {
    if (endsBlankLine(text, index)) {
      return false;
    }
    index += text[index] === "\\" ? 2 : 1;
  }
  if (index >= text.length) {
    return true;
  }
  index++;
  while (/[\t\n\r ]/u.test(text[index] ?? "")) {
    if (endsBlankLine(text, index)) {
      return false;
    }
    index++;
  }
  return index >= text.length;
}

export function scanUnbreakableSpans(
  text: string,
  fenceSpans: FenceSpan[],
  maxChars: number,
): UnbreakableSpan[] {
  const spans: UnbreakableSpan[] = findMarkdownLinkSourceSpans(text, { html: false }).map(
    ([start, end]) => ({ start, end, complete: true }),
  );
  const isInsideCode = buildInlineCodeIndex(text, fenceSpans);
  // Complete Markdown grammar belongs to the parser; only unfinished suffixes need buffering.
  for (
    let labelEnd = text.indexOf("](");
    labelEnd !== -1;
    labelEnd = text.indexOf("](", labelEnd + 2)
  ) {
    if (
      isEscaped(text, labelEnd) ||
      isInsideCode(labelEnd) ||
      spans.some((span) => span.start <= labelEnd && labelEnd < span.end)
    ) {
      continue;
    }
    const labelStart = findMarkdownLabelStart(text, labelEnd, isInsideCode);
    const crossesFence = fenceSpans.some((span) => span.start < labelEnd && span.end > labelStart);
    const invalidLabel =
      labelStart < 0 || isEscaped(text, labelStart) || isInsideCode(labelStart) || crossesFence;
    if (invalidLabel) {
      continue;
    }
    if (!hasUnfinishedMarkdownDestination(text, labelEnd + 2)) {
      continue;
    }
    const start = labelStart > 0 && text[labelStart - 1] === "!" ? labelStart - 1 : labelStart;
    spans.push({ start, end: text.length, complete: false });
  }

  for (const match of text.matchAll(/https?:\/\/[^\s<]+/giu)) {
    const urlStart = match.index;
    if (
      isInsideCode(urlStart) ||
      spans.some((span) => urlStart >= span.start && urlStart < span.end)
    ) {
      continue;
    }
    const start = text[urlStart - 1] === "<" ? urlStart - 1 : urlStart;
    const end = urlStart + match[0].length;
    if (!spans.some((span) => span.start <= start && span.end >= end)) {
      const closesAngleAutolink = start < urlStart && match[0].endsWith(">");
      spans.push({ start, end, complete: closesAngleAutolink || end < text.length });
    }
  }

  for (const opener of URL_OPENERS) {
    for (let length = 1; length <= opener.length; length++) {
      const suffix = opener.slice(0, length);
      if (!text.endsWith(suffix)) {
        continue;
      }
      const start = text.length - length;
      const preceding = text[start - 1];
      if (
        (opener.startsWith("<") || !(preceding && /[\p{L}\p{N}_]/u.test(preceding))) &&
        !isInsideCode(start)
      ) {
        spans.push({ start, end: text.length, complete: false });
      }
    }
  }

  const trailingLabelEnd = text.length - 1;
  const openLabelStart = findOpenMarkdownLabelStart(text, isInsideCode);
  const labelStart =
    openLabelStart >= 0
      ? openLabelStart
      : text[trailingLabelEnd] === "]" && !isEscaped(text, trailingLabelEnd)
        ? findMarkdownLabelStart(text, trailingLabelEnd, isInsideCode)
        : -1;
  if (labelStart >= 0 && !isEscaped(text, labelStart)) {
    const suffix = text.slice(labelStart);
    const close = suffix.indexOf("]");
    const isPartialLabel = close === -1 || close === suffix.length - 1;
    const start = labelStart > 0 && text[labelStart - 1] === "!" ? labelStart - 1 : labelStart;
    const alreadyCovered = spans.some((span) => span.start <= start && span.end >= text.length);
    if (
      isPartialLabel &&
      text.length - start <= maxChars &&
      !alreadyCovered &&
      !isInsideCode(start)
    ) {
      spans.push({ start, end: text.length, complete: false });
    }
  }
  const ordered = spans.toSorted((left, right) => left.start - right.start || right.end - left.end);
  const merged: UnbreakableSpan[] = [];
  for (const span of ordered) {
    const previous = merged.at(-1);
    if (!previous || span.start >= previous.end) {
      merged.push({ ...span });
      continue;
    }
    previous.end = Math.max(previous.end, span.end);
    previous.complete &&= span.complete;
  }
  return merged;
}

export function protectBreakIndex(
  spans: UnbreakableSpan[],
  index: number,
  offset: number,
  force: boolean,
): number {
  let resolved = offset + index;
  for (const span of spans) {
    const endsAtOpenToken = !span.complete && resolved === span.end;
    if (span.start < resolved && (resolved < span.end || endsAtOpenToken)) {
      if (span.start > offset) {
        return span.start - offset;
      }
      if (!span.complete && !force) {
        return -1;
      }
      resolved = Math.max(resolved, span.end);
    }
  }
  return resolved - offset;
}
