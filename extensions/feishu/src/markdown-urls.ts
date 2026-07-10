// Feishu plugin module normalizes post markdown URL behavior.

type Range = {
  start: number;
  end: number;
};

const TRAILING_URL_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?"]);

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
    slashCount++;
  }
  return slashCount % 2 === 1;
}

function isInsideRanges(index: number, ranges: Range[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function collectFencedCodeRanges(text: string): Range[] {
  const ranges: Range[] = [];
  const fenceStartPattern = /^( {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/gm;
  let match: RegExpExecArray | null;
  while ((match = fenceStartPattern.exec(text)) !== null) {
    const marker = match[2];
    const fenceChar = marker[0];
    const minLength = marker.length;
    const closePattern = new RegExp(`^ {0,3}\\${fenceChar}{${minLength},}[^\\n]*(?:\\n|$)`, "gm");
    closePattern.lastIndex = fenceStartPattern.lastIndex;
    const close = closePattern.exec(text);
    const end = close ? close.index + close[0].length : text.length;
    ranges.push({ start: match.index, end });
    fenceStartPattern.lastIndex = end;
  }
  return ranges;
}

function collectInlineCodeRanges(text: string, ranges: Range[]): void {
  for (let index = 0; index < text.length; ) {
    if (text[index] !== "`" || isInsideRanges(index, ranges)) {
      index++;
      continue;
    }

    let runEnd = index + 1;
    while (text[runEnd] === "`") {
      runEnd++;
    }
    const marker = text.slice(index, runEnd);
    const close = text.indexOf(marker, runEnd);
    if (close === -1) {
      index = runEnd;
      continue;
    }
    ranges.push({ start: index, end: close + marker.length });
    index = close + marker.length;
  }
}

function parseBracketLabelEnd(text: string, labelStart: number): number | undefined {
  let depth = 1;
  for (let index = labelStart + 1; index < text.length; index++) {
    const char = text[index];
    if (isEscaped(text, index)) {
      continue;
    }
    if (char === "[") {
      depth++;
      continue;
    }
    if (char === "]") {
      depth--;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return undefined;
}

function parseLinkDestinationEnd(text: string, destinationStart: number): number | undefined {
  let depth = 1;
  for (let index = destinationStart + 1; index < text.length; index++) {
    const char = text[index];
    if (isEscaped(text, index)) {
      continue;
    }
    if (char === "(") {
      depth++;
      continue;
    }
    if (char === ")") {
      depth--;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return undefined;
}

function parseMarkdownLinkEnd(text: string, start: number): number | undefined {
  const labelStart = text[start] === "!" ? start + 1 : start;
  if (text[labelStart] !== "[") {
    return undefined;
  }
  const labelEnd = parseBracketLabelEnd(text, labelStart);
  if (labelEnd === undefined || text[labelEnd] !== "(") {
    return undefined;
  }
  return parseLinkDestinationEnd(text, labelEnd);
}

function collectMarkdownLinkRanges(text: string, ranges: Range[]): void {
  for (let index = 0; index < text.length; index++) {
    if (isInsideRanges(index, ranges)) {
      continue;
    }
    if (text[index] !== "[" && !(text[index] === "!" && text[index + 1] === "[")) {
      continue;
    }
    const end = parseMarkdownLinkEnd(text, index);
    if (end !== undefined) {
      ranges.push({ start: index, end });
      index = end - 1;
    }
  }
}

function collectReferenceLinkDefinitionRanges(text: string, ranges: Range[]): void {
  // Match reference-style link definitions: [label]: url ["title"]
  const refDefPattern = /^ {0,3}\[([^\]]+)\]:\s*(?:<([^>\s]+)>|(\S+))(?:\s*(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = refDefPattern.exec(text)) !== null) {
    if (!isInsideRanges(match.index, ranges)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
}

function collectAngleAutolinkRanges(text: string, ranges: Range[]): void {
  const angleAutolinkPattern = /<https?:\/\/[^>\s]+>/g;
  let match: RegExpExecArray | null;
  while ((match = angleAutolinkPattern.exec(text)) !== null) {
    if (!isInsideRanges(match.index, ranges)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
}

function collectProtectedRanges(text: string): Range[] {
  const ranges = collectFencedCodeRanges(text);
  collectInlineCodeRanges(text, ranges);
  collectMarkdownLinkRanges(text, ranges);
  collectReferenceLinkDefinitionRanges(text, ranges);
  collectAngleAutolinkRanges(text, ranges);
  return ranges.sort((a, b) => a.start - b.start);
}

function isBareUrlStart(text: string, index: number): boolean {
  const previous = text[index - 1];
  return previous === undefined || !/[A-Za-z0-9/]/.test(previous);
}

function findBareUrlEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char) || char === "<" || char === ">" || char === "`") {
      break;
    }
    if (char === "[" || char === "]" || char === "{" || char === "}") {
      break;
    }
    index++;
  }
  return index;
}

function trimBareUrl(rawUrl: string): { url: string; suffix: string } {
  let end = rawUrl.length;
  while (end > 0) {
    const candidate = rawUrl.slice(0, end);
    const last = rawUrl[end - 1];
    if (TRAILING_URL_PUNCTUATION.has(last)) {
      end--;
      continue;
    }
    const openParens = (candidate.match(/\(/g) ?? []).length;
    const closeParens = (candidate.match(/\)/g) ?? []).length;
    if (last === ")" && closeParens > openParens) {
      end--;
      continue;
    }
    break;
  }
  return {
    url: rawUrl.slice(0, end),
    suffix: rawUrl.slice(end),
  };
}

export function preserveFeishuBareMarkdownUrls(text: string): string {
  if (!text.includes("_")) {
    return text;
  }

  if (!/https?:\/\//.test(text)) {
    return text;
  }

  const urlPattern = /https?:\/\//g;

  const protectedRanges = collectProtectedRanges(text);
  let output = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(text)) !== null) {
    const start = match.index;
    if (start < cursor || isInsideRanges(start, protectedRanges) || !isBareUrlStart(text, start)) {
      continue;
    }

    const rawEnd = findBareUrlEnd(text, start);
    const { url, suffix } = trimBareUrl(text.slice(start, rawEnd));
    if (!url.includes("_")) {
      continue;
    }

    output += text.slice(cursor, start);
    output += `[${url}](${url})${suffix}`;
    cursor = rawEnd;
    urlPattern.lastIndex = rawEnd;
  }
  output += text.slice(cursor);
  return output;
}
