type UrlPatternToken = { kind: "lit"; text: string } | { kind: "star" } | { kind: "glob" };
type UrlCursorRange = { start: number; end: number };

function tokenizeBrowserUrlPattern(pattern: string): UrlPatternToken[] {
  const tokens: UrlPatternToken[] = [];
  let literal = "";
  const flush = () => {
    if (!literal) {
      return;
    }
    tokens.push({ kind: "lit", text: literal });
    literal = "";
  };
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char !== "*") {
      literal += char;
      continue;
    }
    flush();
    if (pattern[index + 1] === "*") {
      tokens.push({ kind: "glob" });
      index += 1;
      continue;
    }
    tokens.push({ kind: "star" });
  }
  flush();
  return tokens;
}

function mergeCursorRanges(ranges: UrlCursorRange[]): UrlCursorRange[] {
  if (ranges.length === 0) {
    return [];
  }
  const sorted = ranges.toSorted((left, right) => left.start - right.start || left.end - right.end);
  const merged: UrlCursorRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end + 1) {
      if (range.end > last.end) {
        last.end = range.end;
      }
      continue;
    }
    merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

function literalCursorRanges(
  url: string,
  literal: string,
  ranges: readonly UrlCursorRange[],
): UrlCursorRange[] {
  const next: UrlCursorRange[] = [];
  const width = literal.length;
  for (const range of ranges) {
    let runStart = -1;
    let runEnd = -1;
    const last = Math.min(range.end, url.length - width);
    for (let pos = range.start; pos <= last; pos += 1) {
      if (!url.startsWith(literal, pos)) {
        continue;
      }
      const at = pos + width;
      if (runStart < 0) {
        runStart = at;
        runEnd = at;
      } else if (at <= runEnd + 1) {
        runEnd = at;
      } else {
        next.push({ start: runStart, end: runEnd });
        runStart = at;
        runEnd = at;
      }
    }
    if (runStart >= 0) {
      next.push({ start: runStart, end: runEnd });
    }
  }
  return mergeCursorRanges(next);
}

// `*` stays inside one path segment. The first cursor in a segment already
// reaches that segment's end, so later cursors in the same segment are not
// scanned again.
function starCursorRanges(url: string, ranges: readonly UrlCursorRange[]): UrlCursorRange[] {
  const next: UrlCursorRange[] = [];
  let coveredThrough = -1;
  for (const range of mergeCursorRanges(
    ranges.map((item) => ({ start: item.start, end: item.end })),
  )) {
    let cursor = range.start;
    if (cursor <= coveredThrough) {
      cursor = coveredThrough + 1;
    }
    while (cursor <= range.end) {
      let far = cursor;
      while (far < url.length && url[far] !== "/") {
        far += 1;
      }
      next.push({ start: cursor, end: far });
      coveredThrough = far;
      if (far >= range.end) {
        break;
      }
      cursor = far + 1;
    }
  }
  return mergeCursorRanges(next);
}

// `**` may cross slashes. Every cursor at or after the earliest reachable
// position is reachable, so the result is one range.
function globCursorRanges(url: string, ranges: readonly UrlCursorRange[]): UrlCursorRange[] {
  let start = url.length + 1;
  for (const range of ranges) {
    if (range.start < start) {
      start = range.start;
    }
  }
  if (start > url.length) {
    return [];
  }
  return [{ start, end: url.length }];
}

function rangeContains(ranges: readonly UrlCursorRange[], cursor: number): boolean {
  return ranges.some((range) => range.start <= cursor && cursor <= range.end);
}

function matchBrowserUrlWildcard(pattern: string, url: string): boolean {
  const tokens = tokenizeBrowserUrlPattern(pattern);
  let ranges: UrlCursorRange[] = [{ start: 0, end: 0 }];
  for (const token of tokens) {
    if (token.kind === "lit") {
      ranges = literalCursorRanges(url, token.text, ranges);
    } else if (token.kind === "star") {
      ranges = starCursorRanges(url, ranges);
    } else {
      ranges = globCursorRanges(url, ranges);
    }
    if (ranges.length === 0) {
      return false;
    }
  }
  return rangeContains(ranges, url.length);
}

export function matchBrowserUrlPattern(pattern: string, url: string): boolean {
  const trimmedPattern = pattern.trim();
  if (!trimmedPattern) {
    return false;
  }
  if (trimmedPattern === url || trimmedPattern === "*") {
    return true;
  }
  if (trimmedPattern.includes("*")) {
    return matchBrowserUrlWildcard(trimmedPattern, url);
  }
  return url.includes(trimmedPattern);
}
