const DISCORD_URL_START_RE = /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|www\.|\/\/|mailto:)/giu;

export function findDiscordUrlRanges(markdown: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of markdown.matchAll(DISCORD_URL_START_RE)) {
    const start = match.index;
    const preceding = markdown[start - 1] ?? "";
    if (/[\p{L}\p{N}]/u.test(preceding) || (preceding === "_" && markdown[start - 2] !== "_")) {
      continue;
    }
    let end = start + match[0].length;
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
  }
  return ranges;
}
