type UrlCursorRange = { start: number; end: number };

function mergeCursorRanges(ranges: readonly UrlCursorRange[]): UrlCursorRange[] {
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
    let run: UrlCursorRange | undefined;
    const last = Math.min(range.end, url.length - width);
    for (let pos = range.start; pos <= last; pos += 1) {
      if (!url.startsWith(literal, pos)) {
        continue;
      }
      const at = pos + width;
      if (run && at <= run.end + 1) {
        run.end = at;
      } else {
        run = { start: at, end: at };
        next.push(run);
      }
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
  for (const range of mergeCursorRanges(ranges)) {
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
// position is reachable, so the sorted ranges collapse to one range.
function globCursorRanges(url: string, ranges: readonly UrlCursorRange[]): UrlCursorRange[] {
  const first = ranges[0];
  return first ? [{ start: first.start, end: url.length }] : [];
}

function matchBrowserUrlWildcard(pattern: string, url: string): boolean {
  // Tokenize only; URL matching below stays range-based to avoid backtracking.
  const tokens = pattern.match(/\*\*|\*|[^*]+/g) ?? [];
  let ranges: UrlCursorRange[] = [{ start: 0, end: 0 }];
  for (const token of tokens) {
    if (token === "*") {
      ranges = starCursorRanges(url, ranges);
    } else if (token === "**") {
      ranges = globCursorRanges(url, ranges);
    } else {
      ranges = literalCursorRanges(url, token, ranges);
    }
    if (ranges.length === 0) {
      return false;
    }
  }
  return ranges.some((range) => range.start <= url.length && url.length <= range.end);
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
