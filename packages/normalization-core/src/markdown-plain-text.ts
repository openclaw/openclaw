function stripCompletedLongOrTildeFences(text: string): string {
  if (!text.includes("````") && !text.includes("~~~")) {
    return text;
  }
  let open: { start: number; marker: string } | undefined;
  let cursor = 0;
  let output = "";
  // Keep complete marker runs from backtracking into the trailing text.
  const fenceLines = /(?:^|\n) {0,3}(`{3,}(?!`)|~{3,}(?!~))([^\r\n\u2028\u2029]*)\r?(?=\n|$)/g;
  for (const match of text.matchAll(fenceLines)) {
    const [, marker, trailing] = match;
    if (marker === undefined || trailing === undefined) {
      continue;
    }
    if (!open) {
      if (marker[0] === "`" && trailing.includes("`")) {
        continue;
      }
      open = { start: match.index, marker };
    } else if (
      marker[0] === open.marker[0] &&
      marker.length >= open.marker.length &&
      /^[ \t]*$/.test(trailing)
    ) {
      // Track other fences so their literal long markers cannot consume later prose.
      // Triple-backtick and unfinished fences retain the existing flattening behavior.
      if (open.marker[0] === "~" || open.marker.length > 3) {
        output += text.slice(cursor, open.start) + " ";
        cursor = match.index + match[0].length;
      }
      open = undefined;
    }
  }
  return output + text.slice(cursor);
}

/**
 * Replaces inline code spans with a `\0<index>\0` placeholder and records their
 * literal content, so block-marker and emphasis stripping cannot rewrite code.
 * CommonMark pairs a span by backtick runs of equal length, so code that itself
 * contains a backtick — ``a`b`` — is kept whole instead of being truncated by a
 * single-backtick regex. NULs outside code are doubled so they cannot look like
 * a placeholder. This runs after link stripping so backticks inside link
 * destinations remain visible to link parsing.
 */
function holdInlineCodeSpans(text: string, code: string[]): string {
  let output = "";
  let cursor = 0;
  for (let index = 0; index < text.length;) {
    const char = text.charAt(index);
    if (char === "\0") {
      output += text.slice(cursor, index) + "\0\0";
      cursor = index + 1;
      index += 1;
      continue;
    }
    if (char !== "`") {
      index += 1;
      continue;
    }
    let openLength = 1;
    while (text.charAt(index + openLength) === "`") {
      openLength += 1;
    }
    // Find the next backtick run of exactly this length, which closes the span.
    let close = -1;
    for (let j = index + openLength; j < text.length;) {
      if (text.charAt(j) !== "`") {
        j += 1;
        continue;
      }
      let runLength = 1;
      while (text.charAt(j + runLength) === "`") {
        runLength += 1;
      }
      if (runLength === openLength) {
        close = j;
        break;
      }
      j += runLength;
    }
    if (close === -1) {
      // Consume the whole unmatched run so its tail backticks cannot reopen as a
      // narrower span and steal delimiters from a later valid code span.
      index += openLength;
      continue;
    }
    // A backtick run at the start of a line opens a fenced block, which fence
    // stripping removes whole; inline code may span lines, so only line-start
    // runs are left for the fence pass.
    const atLineStart = index === 0 || text.charAt(index - 1) === "\n";
    if (atLineStart && openLength >= 3) {
      index += openLength;
      continue;
    }
    output += text.slice(cursor, index) + `\0${code.length}\0`;
    code.push(text.slice(index + openLength, close));
    cursor = close + openLength;
    index = cursor;
  }
  return output + text.slice(cursor);
}

/**
 * Flattens Markdown into a single line of readable plain text.
 *
 * For one-line surfaces that render text verbatim — session-list previews,
 * sidebar narration — where unrendered syntax like `[title](url)` would leak
 * to the user. Lossy by design: it drops fenced code entirely and keeps only
 * link/image text, so it must not be used where the Markdown is rendered.
 */
export function flattenMarkdownToPlainText(text: string): string {
  const code: string[] = [];
  // Real fenced blocks are stripped first so their backticks cannot become spans.
  const withoutFences = stripCompletedLongOrTildeFences(text);
  // Link stripping runs on the raw text so backticks inside link destinations stay visible.
  const withoutLinks = stripInlineLinks(withoutFences);
  // Code spans (single- or multi-backtick, matched by equal-length runs) become
  // `\0<index>\0` placeholders so block-marker and emphasis stripping cannot rewrite them.
  const withoutCode = holdInlineCodeSpans(withoutLinks, code)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/```/g, " ");
  // Quote markers may nest with horizontal whitespace, but must not consume another line.
  let flattened = withoutCode.replace(
    /^[\t ]{0,3}(?:(?:>[\t ]*)+|(?:#{1,6}|[-+*]|\d+[.)])\s+)/gm,
    "",
  );
  for (const marker of ["*", "_", "~"] as const) {
    flattened = stripEmphasis(flattened, marker);
  }
  return flattened
    .replace(/\0(\d*)\0/g, (_match, index: string) => (index ? (code[Number(index)] ?? "") : "\0"))
    .replace(/\s+/g, " ")
    .trim();
}

function stripEmphasis(text: string, marker: "*" | "_" | "~"): string {
  const widths: readonly (1 | 2)[] = marker === "~" ? [2] : [2, 1];
  const closers = { 1: 0, 2: 0 };
  // Failed openers share forward-only closing searches instead of rescanning
  // the remaining text. Width preference and the earliest close stay unchanged.
  const findCloser = (width: 1 | 2, start: number): number => {
    const delimiter = marker.repeat(width);
    let index = text.indexOf(delimiter, Math.max(start, closers[width]));
    while (index !== -1) {
      if (
        /\S/.test(text.charAt(index - 1)) &&
        (marker !== "_" || !/^[\p{L}\p{N}]/u.test(text.slice(index + width, index + width + 2)))
      ) {
        closers[width] = index;
        return index;
      }
      index = text.indexOf(delimiter, index + 1);
    }
    closers[width] = text.length;
    return -1;
  };
  let output = "";
  let cursor = 0;
  for (let index = text.indexOf(marker); index !== -1; index = text.indexOf(marker, index + 1)) {
    const previousWidth = (text.codePointAt(index - 2) ?? 0) > 0xffff ? 2 : 1;
    // Underscore matching consumes its left boundary; a previous match's
    // closing marker cannot become that boundary for an adjacent match.
    if (
      marker === "_" &&
      index !== 0 &&
      (index === cursor || /[\p{L}\p{N}]/u.test(text.slice(index - previousWidth, index)))
    ) {
      continue;
    }
    for (const width of widths) {
      const start = index + width;
      if (!text.startsWith(marker.repeat(width), index) || !/\S/.test(text.charAt(start))) {
        continue;
      }
      const end = findCloser(width, start + 1);
      if (end !== -1) {
        output += text.slice(cursor, index) + text.slice(start, end);
        cursor = end + width;
        index = cursor - 1;
        break;
      }
    }
  }
  return output + text.slice(cursor);
}

/** CommonMark link syntax only breaks on ASCII; U+00A0 and other Unicode spaces belong to the destination. */
const ASCII_WHITESPACE = /[\t\n\v\f\r ]/;

function isAsciiSpaceOrControl(char: string): boolean {
  return char <= " " || char === "\x7f";
}

/** Maps each `(` to its balanced `)` within the same whitespace-free run, skipping escapes. */
function matchParens(text: string): Map<number, number> {
  const closers = new Map<number, number>();
  const parens: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === "\\") {
      index += 1;
    } else if (isAsciiSpaceOrControl(char)) {
      parens.length = 0;
    } else if (char === "(") {
      parens.push(index);
    } else if (char === ")") {
      const opener = parens.pop();
      if (opener !== undefined) {
        closers.set(opener, index);
      }
    }
  }
  return closers;
}

const TITLE_CLOSERS: Record<string, string> = { '"': '"', "'": "'", "(": ")" };

function skipSpaces(text: string, start: number): number {
  let index = start;
  while (index < text.length && ASCII_WHITESPACE.test(text.charAt(index))) {
    index += 1;
  }
  return index;
}

/** Returns the index of the `)` closing `(destination "title")` opened at `open`. */
function findDestinationEnd(
  text: string,
  open: number,
  parenClosers: Map<number, number>,
): number | undefined {
  let index = skipSpaces(text, open + 1);
  if (text.charAt(index) === "<") {
    index += 1;
    while (index < text.length && !"<>\n".includes(text.charAt(index))) {
      index += text.charAt(index) === "\\" ? 2 : 1;
    }
    if (text.charAt(index) !== ">") {
      return undefined;
    }
    index += 1;
  } else {
    while (
      index < text.length &&
      text.charAt(index) !== ")" &&
      !isAsciiSpaceOrControl(text.charAt(index))
    ) {
      if (text.charAt(index) === "(") {
        const closer = parenClosers.get(index);
        if (closer === undefined) {
          return undefined;
        }
        index = closer + 1;
      } else {
        index += text.charAt(index) === "\\" ? 2 : 1;
      }
    }
  }
  const titleStart = skipSpaces(text, index);
  const titleCloser = TITLE_CLOSERS[text.charAt(titleStart)];
  if (titleStart > index && titleCloser) {
    index = titleStart + 1;
    while (index < text.length && text.charAt(index) !== titleCloser) {
      if (titleCloser === ")" && text.charAt(index) === "(") {
        return undefined;
      }
      index += text.charAt(index) === "\\" ? 2 : 1;
    }
    index = skipSpaces(text, index + 1);
  } else {
    index = titleStart;
  }
  return text.charAt(index) === ")" ? index : undefined;
}

/**
 * Maps each link label's `[` to its `]` and that `]` to the end of the `(destination "title")`
 * that follows it, skipping backslash-escaped characters. Brackets inside a code span, destination
 * or title are not labels, so they never pair with a label bracket.
 */
function matchLinks(text: string): {
  labelEnds: Map<number, number>;
  destinationEnds: Map<number, number>;
} {
  const labelEnds = new Map<number, number>();
  const destinationEnds = new Map<number, number>();
  const parenClosers = matchParens(text);
  const brackets: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === "\\") {
      index += 1;
    } else if (char === "`") {
      index = Math.max(index, text.indexOf("`", index + 1));
    } else if (char === "[") {
      brackets.push(index);
    } else if (char === "]") {
      const opener = brackets.pop();
      if (opener === undefined) {
        continue;
      }
      labelEnds.set(opener, index);
      const destinationEnd =
        text.charAt(index + 1) === "("
          ? findDestinationEnd(text, index + 1, parenClosers)
          : undefined;
      if (destinationEnd !== undefined) {
        destinationEnds.set(index, destinationEnd);
        index = destinationEnd;
      }
    }
  }
  return { labelEnds, destinationEnds };
}

/** Strips inline link destinations, retaining nested labels and optionally omitting images entirely. */
export function stripInlineLinks(
  text: string,
  options: { images?: "label" | "omit" } = {},
): string {
  const { labelEnds, destinationEnds } = matchLinks(text);
  const suffixEnds = new Map<number, number>();
  let output = "";
  let cursor = 0;
  for (let index = 0; index < text.length; index += 1) {
    const suffixEnd = suffixEnds.get(index);
    if (suffixEnd !== undefined) {
      output += text.slice(cursor, index);
      cursor = suffixEnd;
      index = suffixEnd - 1;
      continue;
    }
    const labelEnd = text[index] === "[" ? labelEnds.get(index) : undefined;
    const destinationEnd = labelEnd === undefined ? undefined : destinationEnds.get(labelEnd);
    if (labelEnd === undefined || destinationEnd === undefined) {
      continue;
    }
    let isImage = index > cursor && text[index - 1] === "!";
    // An odd backslash run escapes the bang, leaving an ordinary link.
    if (isImage) {
      for (let backslash = index - 2; backslash >= 0 && text[backslash] === "\\"; backslash -= 1) {
        isImage = !isImage;
      }
    }
    if (!isImage && labelEnd === index + 1) {
      continue;
    }
    output += text.slice(cursor, isImage ? index - 1 : index);
    if (isImage && options.images === "omit") {
      cursor = destinationEnd + 1;
      index = destinationEnd;
      continue;
    }
    cursor = index + 1;
    suffixEnds.set(labelEnd, destinationEnd + 1);
  }
  return output + text.slice(cursor);
}
