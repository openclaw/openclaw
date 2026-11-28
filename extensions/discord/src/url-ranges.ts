// A scheme is only tried where a run of scheme characters begins, and its URL starts at
// the run's first letter. Each character is then scanned by a bounded number of attempts.
const DISCORD_URL_START_RE =
  /(?<![A-Za-z0-9+.-])([0-9+.-]*)[A-Za-z][A-Za-z0-9+.-]*:\/\/|www\.|\/\/|mailto:/giu;

export function findDiscordUrlRanges(markdown: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  DISCORD_URL_START_RE.lastIndex = 0;
  for (
    let match = DISCORD_URL_START_RE.exec(markdown);
    match;
    match = DISCORD_URL_START_RE.exec(markdown)
  ) {
    const start = match.index + (match[1]?.length ?? 0);
    const preceding = markdown[start - 1] ?? "";
    if (/[\p{L}\p{N}]/u.test(preceding) || (preceding === "_" && markdown[start - 2] !== "_")) {
      continue;
    }
    let end = match.index + match[0].length;
    let parenthesisDepth = 0;
    while (end < markdown.length) {
      const char = markdown[end];
      if (!char || /[\s<>]/u.test(char)) {
        break;
      }
      if (char === "(") {
        parenthesisDepth += 1;
      } else if (char === ")") {
        if (parenthesisDepth === 0) {
          break;
        }
        parenthesisDepth -= 1;
      }
      end += 1;
    }
    while (/[.,!?;:'"]/u.test(markdown[end - 1] ?? "")) {
      end -= 1;
    }
    ranges.push({ start, end });
    // A URL start found inside this range would only yield a range nested within it.
    DISCORD_URL_START_RE.lastIndex = Math.max(DISCORD_URL_START_RE.lastIndex, end);
  }
  return ranges;
}
