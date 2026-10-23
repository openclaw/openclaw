export function sourceLineOffset(raw: string, line: number): number {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const newline = raw.indexOf("\n", offset);
    if (newline === -1) {
      return raw.length;
    }
    offset = newline + 1;
  }
  return offset;
}

export function sourceLineEnding(raw: string): "\r\n" | "\n" {
  const crlfCount = (raw.match(/\r\n/g) ?? []).length;
  const lfCount = (raw.match(/\n/g) ?? []).length;
  return crlfCount > 0 && crlfCount * 2 >= lfCount ? "\r\n" : "\n";
}
