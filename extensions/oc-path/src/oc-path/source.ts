export function sourceLineOffset(raw: string, line: number, lineBreaks = /\r\n?|\n/g): number {
  if (line <= 1) {
    return 0;
  }
  let current = 1;
  for (const match of raw.matchAll(lineBreaks)) {
    current += 1;
    if (current === line) {
      return match.index + match[0].length;
    }
  }
  return raw.length;
}

export function sourceLineEnding(raw: string): "\r\n" | "\n";
export function sourceLineEnding(raw: string, standaloneCr: true): "\r\n" | "\n" | "\r";
export function sourceLineEnding(raw: string, standaloneCr = false): "\r\n" | "\n" | "\r" {
  const crlfCount = (raw.match(/\r\n/g) ?? []).length;
  const lfCount = (raw.match(/\n/g) ?? []).length;
  const crCount = standaloneCr ? (raw.match(/\r(?!\n)/g) ?? []).length : 0;
  if (crCount > crlfCount && crCount > lfCount - crlfCount) {
    return "\r";
  }
  return crlfCount > 0 && crlfCount * 2 >= lfCount ? "\r\n" : "\n";
}
