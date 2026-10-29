export function scanParenAwareBreakpoints(
  text: string,
  start: number,
  end: number,
  skipTo?: (index: number) => number | undefined,
): { lastNewline: number; lastWhitespace: number } {
  let lastNewline = -1;
  let lastWhitespace = -1;
  if (!skipTo) {
    const window = text.slice(start, end);
    if (!window.includes("(")) {
      const newline = window.lastIndexOf("\n");
      lastNewline = newline < 0 ? -1 : start + newline;
      // The suffix excludes non-LF whitespace, selecting the final eligible separator.
      const whitespace = window.search(/[^\S\n][\S\n]*$/);
      lastWhitespace = whitespace < 0 ? -1 : start + whitespace;
      return { lastNewline, lastWhitespace };
    }
  }
  let depth = 0;

  for (let i = start; i < end; i++) {
    const skippedEnd = skipTo?.(i);
    if (skippedEnd !== undefined) {
      // The fence end remains an eligible breakpoint; resume there after the loop increment.
      i = skippedEnd - 1;
      continue;
    }
    const char = text.charAt(i);
    // Keep parenthesized links or file references together when an outside break is available.
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (char === "\n") {
      lastNewline = i;
    } else if (/\s/.test(char)) {
      lastWhitespace = i;
    }
  }

  return { lastNewline, lastWhitespace };
}
