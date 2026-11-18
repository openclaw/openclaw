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

function splitTableRow(line: string): string[] | undefined {
  if (
    !line.includes("|") ||
    /^(?: {4}| {0,3}\t)/.test(line) ||
    /^ {0,3}(?:>|#{1,6}(?:\s|$)|(?:[-+*]|\d+[.)])\s)/.test(line)
  ) {
    return undefined;
  }
  const cells: string[] = [];
  let start = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "\\") {
      index += 1;
    } else if (line[index] === "|") {
      cells.push(line.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (cells.length === 0) {
    return undefined;
  }
  cells.push(line.slice(start).trim());
  if (cells[0] === "") {
    cells.shift();
  }
  if (cells.at(-1) === "") {
    cells.pop();
  }
  return cells.length > 0 ? cells : undefined;
}

function stripTables(text: string): string {
  if (!text.includes("|")) {
    return text;
  }
  const lines = text.split("\n");
  const rows = lines.map(splitTableRow);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = rows[index];
    const delimiter = rows[index + 1];
    // Only a matching header and delimiter establish a table; prose pipes stay literal.
    if (
      !header ||
      !delimiter ||
      header.length !== delimiter.length ||
      !delimiter.every((cell) => /^:?-+:?$/.test(cell))
    ) {
      continue;
    }
    lines[index] = header.join(" ").replace(/\\\|/g, "|");
    lines[++index] = "";
    for (let row = rows[index + 1]; row; row = rows[index + 1]) {
      lines[++index] = row.join(" ").replace(/\\\|/g, "|");
    }
  }
  return lines.join("\n");
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
  const withoutFences = stripCompletedLongOrTildeFences(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/```/g, " ");
  // Code spans become `\0<index>\0` so block and emphasis stripping cannot rewrite them; other NULs are doubled.
  // A span closes on the next backtick run of its own length, so ``a`b`` keeps its inner backtick.
  const withoutCode = stripInlineLinks(withoutFences).replace(
    /\0|(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g,
    (_match, _run: string | undefined, literal: string | undefined) =>
      literal === undefined ? "\0\0" : `\0${code.push(literal) - 1}\0`,
  );
  // Quote markers may nest with horizontal whitespace, but must not consume another line.
  // Recognize tables before removing block markers: a following heading or list is not a row.
  let flattened = stripTables(withoutCode).replace(
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

/** Strips inline link destinations, retaining nested labels and optionally omitting images entirely. */
export function stripInlineLinks(
  text: string,
  options: { images?: "label" | "omit" } = {},
): string {
  const skips = new Map<number, number>();
  const parenClosers = matchParens(text);
  const brackets: number[] = [];
  // Brackets inside escapes, code spans, and recognized destinations cannot match a label.
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
      if (opener === undefined || text.charAt(index + 1) !== "(") {
        continue;
      }
      const end = findDestinationEnd(text, index + 1, parenClosers);
      if (end === undefined) {
        continue;
      }
      let isImage = text.charAt(opener - 1) === "!";
      // An odd backslash run escapes the bang, leaving an ordinary link.
      if (isImage) {
        for (let backslash = opener - 2; text.charAt(backslash) === "\\"; backslash -= 1) {
          isImage = !isImage;
        }
      }
      if (isImage && options.images === "omit") {
        skips.set(opener - 1, end + 1);
      } else if (isImage || opener + 1 < index) {
        skips.set(isImage ? opener - 1 : opener, opener + 1);
        skips.set(index, end + 1);
      }
      index = end;
    }
  }
  if (skips.size === 0) {
    return text;
  }
  let output = "";
  let cursor = 0;
  // Walk the source, not the map: an omitted image covers any edits inside its label.
  for (let index = 0; index < text.length; index += 1) {
    const end = skips.get(index);
    if (end !== undefined) {
      output += text.slice(cursor, index);
      cursor = end;
      index = end - 1;
    }
  }
  return output + text.slice(cursor);
}
